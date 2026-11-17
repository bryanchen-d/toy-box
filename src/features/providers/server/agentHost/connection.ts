// One remote session on a node's agent host, adapted to the Sessions contract. Its subscription
// keeps Agent Teams the session's active client, so the host hands Agent Teams' tools to it to
// run; the host's held native calls are answered through Security's guard; and every chat action
// is projected into session events.

import {
  ActionType,
  MessageKind,
  chatReducer,
  type ChatState,
  type SessionActiveClient,
} from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { z, ZodError } from "zod";
import type { ModelConfiguration } from "@providers/model";
import type { AgentAction } from "@security/model";
import {
  SessionConnectionUnavailableError,
  type SessionConfiguration,
  type SessionConnection,
} from "@providers/server/provider";
import { copilotAction } from "@providers/server/copilot/guard";
import type { SessionEvent, SessionMessage } from "@sessions/model";
import { encodeSystemMessage, systemMessagePrompt } from "@sessions/model/systemMessages";
import { normalizeToolResult, type Tool } from "@sessions/server/tools/definition";
import {
  createChatProjector,
  currentParts,
  INSTRUCTIONS_END,
  INSTRUCTIONS_START,
  resultText,
  SYSTEM_MESSAGE_META,
  toolArguments,
  type NativeChat,
  type NativeToolCall,
} from "./projector";

export type RemoteSession = {
  providerId: string;
  client: AhpClient;
  clientId: string;
  sessionId: string;
  /** The host's model IDs; a message names its model only when the host offers it. */
  models: readonly string[];
  configuration: SessionConfiguration;
};

export function sessionUri(sessionId: string): string {
  return `ahp-session:/${sessionId}`;
}

/** Agent Teams' tools, offered to the session as this client's own. */
export function activeClient(clientId: string, tools: readonly Tool<any>[]): SessionActiveClient {
  return {
    clientId,
    displayName: "Agent Teams",
    tools: tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: (tool.parameters
        ? z.toJSONSchema(tool.parameters)
        : {
            type: "object",
            properties: {},
          }) as SessionActiveClient["tools"][number]["inputSchema"],
    })),
  };
}

/** The session's default chat, which the host adds shortly after creating the session. */
export async function defaultChat(client: AhpClient, session: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { snapshot } = await client.request("subscribe", { channel: session });
    const chat = (snapshot?.state as { defaultChat?: string } | undefined)?.defaultChat;
    if (chat) return chat;
    await Bun.sleep(500);
  }
  throw new Error(`The remote session ${session} has no chat.`);
}

export async function connectRemoteSession(remote: RemoteSession): Promise<SessionConnection> {
  const { client, clientId, sessionId, configuration } = remote;
  const session = sessionUri(sessionId);
  const chatUri = await defaultChat(client, session);
  client.dispatch(session, {
    type: ActionType.SessionActiveClientSet,
    activeClient: activeClient(clientId, configuration.tools),
  });
  const { result, subscription } = await client.subscribe(chatUri);
  let state = result.snapshot?.state as ChatState;
  const chat = () => state as unknown as NativeChat;
  // A new session's first message carries Agent Teams' instructions.
  let instructions = chat().turns.length === 0 && !chat().activeTurn && !state.turnsNextCursor;
  let model = configuration.model;
  let closed = false;
  let lost = false;
  const listeners = new Set<(event: SessionEvent) => void>();
  const handled = new Set<string>();
  const emit = (event: SessionEvent) => {
    for (const listener of listeners) listener(event);
  };

  void (async () => {
    const project = createChatProjector();
    try {
      for await (const event of subscription) {
        if (event.type !== "action") continue;
        // A newer host sends actions this client's reducer doesn't know; none change a turn.
        state = chatReducer(state, event.params.action as never, () => {});
        for (const projected of project(event.params.action, chat())) emit(projected);
        answerHost();
      }
    } catch (error) {
      if (!closed) console.error(`Remote session ${sessionId} stopped listening:`, error);
    }
    if (closed) return;
    lost = true;
    emit({ type: "end", reason: "error", error: "The connection to the remote session closed." });
  })();
  // A turn that ran while no connection was open may hold calls for this client; the ones it
  // finished were screened by the connection that saw them finish.
  for (const { toolCall } of currentParts(chat())) {
    if (toolCall?.status === "completed") handled.add(`${toolCall.toolCallId}:completed`);
  }
  answerHost();

  /** Everything the host waits on this client for, once for each state it waits in. */
  function answerHost(): void {
    const turnId = chat().activeTurn?.id;
    if (!turnId) return;
    for (const { toolCall: call, kind, request, response } of currentParts(chat())) {
      // Nobody watches a remote session to answer its questions; it decides or reports instead.
      if (kind === "inputRequest" && request && !response && !handled.has(request.id)) {
        handled.add(request.id);
        client.dispatch(chatUri, {
          type: ActionType.ChatInputCompleted,
          requestId: request.id,
          response: "decline",
        } as never);
      }
      if (!call) continue;
      const key = `${call.toolCallId}:${call.status}`;
      if (handled.has(key)) continue;
      const ours = call.contributor?.kind === "client" && call.contributor.clientId === clientId;
      const action = copilotAction(call.toolName, toolArguments(call.toolInput));
      let work: Promise<unknown> | undefined;
      if (call.status === "pending-confirmation") {
        work = confirm(turnId, call, ours ? undefined : action);
      } else if (call.status === "running" && ours) work = runTool(turnId, call);
      else if (call.status === "pending-result-confirmation") {
        // The guard screens the result once the call completes; it can't replace what the host holds.
        client.dispatch(chatUri, {
          type: ActionType.ChatToolCallResultConfirmed,
          turnId,
          toolCallId: call.toolCallId,
          approved: true,
        });
      } else if (call.status === "completed" && !ours) {
        // Records external writes and judges untrusted reads; the model already has the result.
        work = configuration.toolGuard.screen(action, resultText(call));
      } else continue;
      handled.add(key);
      work?.catch((error) =>
        console.error(
          `Couldn't handle remote tool call ${call.toolName} (${call.toolCallId}):`,
          error,
        ),
      );
    }
  }

  /**
   * Native calls wait for the guard's review of their action. The host also holds this client's
   * own tools, which are reviewed when they run.
   */
  async function confirm(turnId: string, call: NativeToolCall, native?: AgentAction) {
    const decision = native
      ? await configuration.toolGuard.review(native)
      : ({ allowed: true } as const);
    const option = call.options?.find(
      ({ kind }) => kind === (decision.allowed ? "approve" : "deny"),
    );
    const selected = option ? { selectedOptionId: option.id } : {};
    const target = { turnId, toolCallId: call.toolCallId };
    client.dispatch(
      chatUri,
      (decision.allowed
        ? {
            type: ActionType.ChatToolCallConfirmed,
            ...target,
            approved: true,
            confirmed: "user-action",
            ...selected,
          }
        : {
            type: ActionType.ChatToolCallConfirmed,
            ...target,
            approved: false,
            reason: "denied",
            reasonMessage: decision.reason,
            ...selected,
          }) as never,
    );
  }

  async function runTool(turnId: string, call: NativeToolCall): Promise<void> {
    const tool = configuration.tools.find(({ name }) => name === call.toolName);
    const args = toolArguments(call.toolInput);
    const action = copilotAction(call.toolName, args);
    const decision = await configuration.toolGuard.review(action);
    let outcome: { success: boolean; text: string };
    if (!tool)
      outcome = { success: false, text: `Agent Teams has no tool named ${call.toolName}.` };
    else if (!decision.allowed) outcome = { success: false, text: decision.reason };
    else {
      try {
        const output = normalizeToolResult(
          await tool.handler(tool.parameters ? tool.parameters.parse(args) : args, {
            sessionId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            arguments: args,
          }),
        );
        const text = output.content
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .join("\n");
        outcome = {
          success: !output.isError,
          text: await configuration.toolGuard.screen(action, text),
        };
      } catch (error) {
        if (!(error instanceof ZodError)) {
          console.error(`Tool ${call.toolName} failed in remote session ${sessionId}:`, error);
        }
        outcome = { success: false, text: toolErrorText(error) };
      }
    }
    client.dispatch(chatUri, {
      type: ActionType.ChatToolCallComplete,
      turnId,
      toolCallId: call.toolCallId,
      result: {
        success: outcome.success,
        pastTenseMessage: `${outcome.success ? "Ran" : "Failed to run"} ${call.toolName}`,
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.success ? {} : { error: { message: outcome.text } }),
      },
    } as never);
  }

  function nativeMessage(message: SessionMessage) {
    const prompt =
      message.role === "system" ? systemMessagePrompt(message.content) : message.content;
    const text = instructions
      ? `${INSTRUCTIONS_START}\n${configuration.instructions}\n${INSTRUCTIONS_END}\n\n${prompt}`
      : prompt;
    instructions = false;
    return {
      text,
      origin: { kind: MessageKind.User },
      ...(model && remote.models.includes(model.name) ? { model: { id: model.name } } : {}),
      ...(message.role === "system"
        ? { _meta: { [SYSTEM_MESSAGE_META]: encodeSystemMessage(message.content) } }
        : {}),
    };
  }

  return {
    provider: { id: remote.providerId },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(message) {
      if (lost)
        throw new SessionConnectionUnavailableError("The remote session's node disconnected.");
      const active = chat().activeTurn;
      if (!active) {
        client.dispatch(chatUri, {
          type: ActionType.ChatTurnStarted,
          turnId: message.clientId,
          startedAt: new Date().toISOString(),
          message: nativeMessage(message),
        } as never);
        return;
      }
      // Sessions sends during a turn only to steer it; the host takes the message into that turn.
      client.dispatch(chatUri, {
        type: ActionType.ChatPendingMessageSet,
        kind: "steering",
        id: message.clientId,
        message: nativeMessage(message),
      } as never);
      emit(
        message.role === "system"
          ? { type: "system_message", content: message.content, clientId: message.clientId }
          : { type: "user_message", content: message.content, clientId: message.clientId },
      );
    },
    async setModel(next: ModelConfiguration) {
      model = next;
    },
    async answerQuestion() {
      return false;
    },
    async abort() {
      if (lost) return;
      const { activeTurn, steeringMessage } = chat();
      // Stopping drops a pending steering message too, or the host would start a turn from it.
      if (steeringMessage) {
        client.dispatch(chatUri, {
          type: ActionType.ChatPendingMessageRemoved,
          kind: "steering",
          id: steeringMessage.id,
        } as never);
      }
      if (!activeTurn) return;
      client.dispatch(chatUri, {
        type: ActionType.ChatTurnCancelled,
        turnId: activeTurn.id,
        duration: 0,
      } as never);
    },
    async disconnect() {
      closed = true;
      await Promise.allSettled([client.unsubscribe(chatUri), client.unsubscribe(session)]);
    },
    async rename() {
      return false;
    },
    async rewind() {
      throw new Error("A remote session can't be rewound.");
    },
  };
}

function toolErrorText(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("\n");
  }
  return error instanceof Error ? error.message : String(error);
}
