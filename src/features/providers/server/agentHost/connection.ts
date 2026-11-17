// One remote session on a node's agent host, adapted to the Sessions contract. Its subscription
// keeps Agent Teams the session's active client, so the host hands Agent Teams' tools to it to
// run; the host's held native calls are answered through Security's guard; and every chat action
// is projected into session events. A run goes on at the node when its connection drops, so the
// connection waits for the node, rejoins the session, and catches its transcript up.

import {
  ActionType,
  MessageKind,
  chatReducer,
  type ChatState,
  type RootState,
  type SessionActiveClient,
} from "@microsoft/agent-host-protocol";
import type { AhpClient, Subscription } from "@microsoft/agent-host-protocol/client";
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

/** A node's link to its agent host, which its provider runs sessions through. */
export type AgentHost = {
  readonly node: { readonly name: string; readonly scratchFolder: string };
  /** The connected host's client, or undefined while the node is out of reach. */
  readonly client: AhpClient | undefined;
  readonly clientId: string;
  readonly agents: RootState["agents"];
  /** The client once the node is connected; undefined once it is unreachable or gone. */
  whenConnected(signal?: AbortSignal): Promise<AhpClient | undefined>;
  /** Calls `listener` with the client each time the node connects, until it unsubscribes. */
  onConnected(listener: (client: AhpClient) => void): () => void;
};

export type RemoteSession = {
  providerId: string;
  host: AgentHost;
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
  const { host, sessionId, configuration } = remote;
  const session = sessionUri(sessionId);
  if (!host.client) {
    throw new SessionConnectionUnavailableError(`The node ${host.node.name} is out of reach.`);
  }
  // Disconnecting, or stopping while the node is away, ends the connection for good.
  const stopped = new AbortController();
  let client = host.client;
  let chatUri = "";
  let state = { turns: [] } as unknown as ChatState;
  const chat = () => state as unknown as NativeChat;
  let subscription = await join(client);
  // A new session's first message carries Agent Teams' instructions.
  let instructions = chat().turns.length === 0 && !chat().activeTurn && !state.turnsNextCursor;
  let model = configuration.model;
  let away = false;
  const listeners = new Set<(event: SessionEvent) => void>();
  const project = createChatProjector();
  // What this client answered for each call the host waited on, by the state it waited in.
  const answers = new Map<string, object>();
  const emit = (event: SessionEvent) => {
    for (const listener of listeners) listener(event);
  };

  /** Opens the session on a client and registers Agent Teams' tools with it. */
  async function join(next: AhpClient): Promise<Subscription> {
    const uri = await defaultChat(next, session);
    next.dispatch(session, {
      type: ActionType.SessionActiveClientSet,
      activeClient: activeClient(host.clientId, configuration.tools),
    });
    const { result, subscription: joined } = await next.subscribe(uri);
    client = next;
    chatUri = uri;
    state = (result.snapshot?.state ?? { turns: [] }) as ChatState;
    return joined;
  }

  void (async () => {
    for (;;) {
      try {
        for await (const event of subscription) {
          if (event.type !== "action") continue;
          // A newer host sends actions this client's reducer doesn't know; none change a turn.
          state = chatReducer(state, event.params.action as never, () => {});
          for (const projected of project.project(event.params.action, chat())) emit(projected);
          answerHost();
        }
      } catch (error) {
        if (!stopped.signal.aborted) console.error(`Remote session ${sessionId} dropped:`, error);
      }
      if (stopped.signal.aborted) return;
      away = true;
      const next = await host.whenConnected(stopped.signal);
      if (stopped.signal.aborted) return;
      const joined = next
        ? await join(next).catch((error: unknown) => {
            console.error(`Remote session ${sessionId} couldn't rejoin:`, error);
            return undefined;
          })
        : undefined;
      if (!joined) {
        stopped.abort();
        emit({
          type: "end",
          reason: "error",
          error: `${host.node.name} is out of reach, so Agent Teams stopped following this run. It may have kept running there.`,
        });
        return;
      }
      subscription = joined;
      away = false;
      for (const projected of project.catchUp(chat())) emit(projected);
      resendAnswers();
      answerHost();
    }
  })();

  // A turn that ran while no connection was open may hold calls for this client; the ones it
  // finished were screened by the connection that saw them finish.
  for (const { toolCall } of currentParts(chat())) {
    if (toolCall?.status === "completed") answers.set(`${toolCall.toolCallId}:completed`, {});
  }
  answerHost();

  /** Sends an answer to the host, which `resendAnswers` repeats if a drop lost it. */
  function answer(key: string, action: object): void {
    answers.set(key, action);
    try {
      client.dispatch(chatUri, action as never);
    } catch {
      // The node dropped; rejoining resends it.
    }
  }

  /** Answers again each call the host still waits on, since a drop may have lost the answer. */
  function resendAnswers(): void {
    for (const { toolCall: call, request } of currentParts(chat())) {
      const key = call ? `${call.toolCallId}:${call.status}` : request?.id;
      const action = key === undefined ? undefined : answers.get(key);
      if (action && Object.keys(action).length > 0) answer(key!, action);
    }
  }

  /** Everything the host waits on this client for, once for each state it waits in. */
  function answerHost(): void {
    const turnId = chat().activeTurn?.id;
    if (!turnId) return;
    for (const { toolCall: call, kind, request, response } of currentParts(chat())) {
      // Nobody watches a remote session to answer its questions; it decides or reports instead.
      if (kind === "inputRequest" && request && !response && !answers.has(request.id)) {
        answer(request.id, {
          type: ActionType.ChatInputCompleted,
          requestId: request.id,
          response: "decline",
        });
      }
      if (!call) continue;
      const key = `${call.toolCallId}:${call.status}`;
      if (answers.has(key)) continue;
      const ours =
        call.contributor?.kind === "client" && call.contributor.clientId === host.clientId;
      const action = copilotAction(call.toolName, toolArguments(call.toolInput));
      let work: Promise<unknown> | undefined;
      if (call.status === "pending-confirmation") {
        work = confirm(key, turnId, call, ours ? undefined : action);
      } else if (call.status === "running" && ours) work = runTool(key, turnId, call);
      else if (call.status === "pending-result-confirmation") {
        // The guard screens the result once the call completes; it can't replace what the host holds.
        answer(key, {
          type: ActionType.ChatToolCallResultConfirmed,
          turnId,
          toolCallId: call.toolCallId,
          approved: true,
        });
      } else if (call.status === "completed" && !ours) {
        // Records external writes and judges untrusted reads; the model already has the result.
        work = configuration.toolGuard.screen(action, resultText(call));
      } else continue;
      // Claimed before its work settles, so the next action doesn't start it again.
      if (!answers.has(key)) answers.set(key, {});
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
  async function confirm(key: string, turnId: string, call: NativeToolCall, native?: AgentAction) {
    const decision = native
      ? await configuration.toolGuard.review(native)
      : ({ allowed: true } as const);
    const option = call.options?.find(
      ({ kind }) => kind === (decision.allowed ? "approve" : "deny"),
    );
    const target = {
      type: ActionType.ChatToolCallConfirmed,
      turnId,
      toolCallId: call.toolCallId,
      ...(option ? { selectedOptionId: option.id } : {}),
    };
    answer(
      key,
      decision.allowed
        ? { ...target, approved: true, confirmed: "user-action" }
        : { ...target, approved: false, reason: "denied", reasonMessage: decision.reason },
    );
  }

  async function runTool(key: string, turnId: string, call: NativeToolCall): Promise<void> {
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
    answer(key, {
      type: ActionType.ChatToolCallComplete,
      turnId,
      toolCallId: call.toolCallId,
      result: {
        success: outcome.success,
        pastTenseMessage: `${outcome.success ? "Ran" : "Failed to run"} ${call.toolName}`,
        content: [{ type: "text", text: outcome.text }],
        ...(outcome.success ? {} : { error: { message: outcome.text } }),
      },
    });
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

  /** Sends a message's action, or reports it unsent when the node has just dropped. */
  function submit(action: object): void {
    try {
      if (stopped.signal.aborted || away) throw new Error("away");
      client.dispatch(chatUri, action as never);
    } catch {
      throw new SessionConnectionUnavailableError(`The node ${host.node.name} is out of reach.`);
    }
  }

  return {
    provider: { id: remote.providerId },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async send(message) {
      const active = chat().activeTurn;
      if (!active) {
        submit({
          type: ActionType.ChatTurnStarted,
          turnId: message.clientId,
          startedAt: new Date().toISOString(),
          message: nativeMessage(message),
        });
        return;
      }
      // Sessions sends during a turn only to steer it; the host takes the message into that turn.
      submit({
        type: ActionType.ChatPendingMessageSet,
        kind: "steering",
        id: message.clientId,
        message: nativeMessage(message),
      });
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
      // A node that's away can't be told to stop; the run may go on there.
      if (away) stopped.abort();
      if (stopped.signal.aborted) return;
      const { activeTurn, steeringMessage } = chat();
      try {
        // Stopping drops a pending steering message too, or the host would start a turn from it.
        if (steeringMessage) {
          submit({
            type: ActionType.ChatPendingMessageRemoved,
            kind: "steering",
            id: steeringMessage.id,
          });
        }
        if (activeTurn) {
          submit({ type: ActionType.ChatTurnCancelled, turnId: activeTurn.id, duration: 0 });
        }
      } catch {
        // The node dropped as it was stopped; the run may go on there.
      }
    },
    async disconnect() {
      stopped.abort();
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
