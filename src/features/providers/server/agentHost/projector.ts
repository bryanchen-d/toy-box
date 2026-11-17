// Projects an Agent Host Protocol chat into Agent Teams session events: each action live, read with
// the chat state it produced, and a chat's completed turns when history is read, so a remote turn
// builds the same transcript whether it is watched or reopened. Native shapes stay in this folder.

import { ActionType } from "@microsoft/agent-host-protocol";
import type { JSONType } from "zod";
import type { SessionEvent } from "@sessions/model";
import { decodeSystemMessage } from "@sessions/model/systemMessages";

/** The display form of a system message Agent Teams sent, kept on the native message. */
export const SYSTEM_MESSAGE_META = "agent-teams/system-message";
/** Agent Teams' instructions ride ahead of a session's first message, out of its transcript. */
export const INSTRUCTIONS_START = "<agent_teams_instructions>";
export const INSTRUCTIONS_END = "</agent_teams_instructions>";

type Text = string | { markdown?: string; value?: string } | undefined;
type ResultContent = { type: string; text?: string; result?: { preview?: string } };
export type NativeToolCall = {
  toolCallId: string;
  toolName: string;
  status: string;
  toolInput?: unknown;
  contributor?: { kind: string; clientId?: string };
  options?: { id: string; kind: string }[];
  reasonMessage?: Text;
  success?: boolean;
  content?: ResultContent[];
  pastTenseMessage?: Text;
  error?: { message?: string };
};
type NativePart = {
  kind: string;
  id?: string;
  content?: string;
  toolCall?: NativeToolCall;
  request?: { id: string };
  response?: string;
};
type NativeMessage = { text: string; _meta?: Record<string, unknown> };
export type NativeTurn = {
  id: string;
  message: NativeMessage;
  responseParts: NativePart[];
  state?: string;
};
export type NativeChat = {
  turns: NativeTurn[];
  activeTurn?: { id: string; message: NativeMessage; responseParts: NativePart[] };
  /** A message steering the active turn, which the host may start a new turn from. */
  steeringMessage?: { id: string };
};
type NativeAction = {
  type: string;
  turnId?: string;
  partId?: string;
  toolCallId?: string;
  content?: string;
  message?: NativeMessage;
  queuedMessageId?: string;
  part?: NativePart & { error?: { message?: string } };
  approved?: boolean;
  reasonMessage?: Text;
  result?: Pick<NativeToolCall, "success" | "content" | "pastTenseMessage" | "error">;
};

/** The parts of the turn an action belongs to: the active one, else the latest completed one. */
export function currentParts(chat: NativeChat): NativePart[] {
  return chat.activeTurn?.responseParts ?? chat.turns.at(-1)?.responseParts ?? [];
}

export function findToolCall(chat: NativeChat, toolCallId: string): NativeToolCall | undefined {
  return currentParts(chat).find((part) => part.toolCall?.toolCallId === toolCallId)?.toolCall;
}

/**
 * A live projector: one per remote session connection, since it remembers the turn it follows,
 * which reply is still streaming, and what it has already emitted. After a gap in which actions
 * were missed, `catchUp` brings the transcript up to the chat's current state.
 */
export function createChatProjector() {
  let turnId: string | undefined;
  let openReply: string | undefined;
  const replies = new Set<string>();
  const started = new Set<string>();
  // The host echoes a client tool's completion and then reports its own; one ends the call.
  const ended = new Set<string>();

  function closeReply(parts: readonly NativePart[]): SessionEvent[] {
    const reply = parts.find((part) => part.kind === "markdown" && part.id === openReply);
    openReply = undefined;
    if (!reply) return [];
    replies.add(reply.id!);
    return [{ type: "assistant_message", messageId: reply.id, content: reply.content ?? "" }];
  }

  function toolEnd(event: Extract<SessionEvent, { type: "tool_end" }>): SessionEvent[] {
    if (ended.has(event.toolCallId)) return [];
    ended.add(event.toolCallId);
    return [event];
  }

  function toolStarted(call: NativeToolCall): SessionEvent[] {
    if (started.has(call.toolCallId)) return [];
    started.add(call.toolCallId);
    return [toolStart(call)];
  }

  /** The replies and tool calls in `parts` not yet emitted; an active turn's last reply stays open. */
  function catchUpParts(parts: readonly NativePart[], active: boolean): SessionEvent[] {
    openReply = undefined;
    return parts.flatMap((part, index): SessionEvent[] => {
      if (part.kind === "markdown" && !replies.has(part.id!)) {
        if (active && index === parts.length - 1) openReply = part.id;
        else replies.add(part.id!);
        return [{ type: "assistant_message", messageId: part.id, content: part.content ?? "" }];
      }
      const call = part.toolCall;
      if (!call) return [];
      return [
        ...toolStarted(call),
        ...(call.status === "completed"
          ? toolEnd({
              type: "tool_end",
              toolCallId: call.toolCallId,
              success: call.success ?? false,
              result: resultText(call),
            })
          : call.status === "cancelled"
            ? toolEnd({
                type: "tool_end",
                toolCallId: call.toolCallId,
                success: false,
                result: text(call.reasonMessage),
              })
            : []),
      ];
    });
  }

  function project(raw: unknown, chat: NativeChat): SessionEvent[] {
    const action = raw as NativeAction;
    switch (action.type) {
      case ActionType.ChatTurnStarted:
        turnId = action.turnId;
        return [
          // A turn the host starts from a steering message carries on the turn it steered.
          messageEvent(action.message!, action.queuedMessageId ?? action.turnId!),
          { type: "status", status: "thinking" },
        ];
      case ActionType.ChatResponsePart: {
        const part = action.part!;
        if (part.kind === "markdown") {
          const closed = closeReply(currentParts(chat));
          openReply = part.id;
          return part.content
            ? [...closed, { type: "delta", messageId: part.id, content: part.content }]
            : closed;
        }
        if (part.kind === "reasoning") {
          const closed = closeReply(currentParts(chat));
          return part.content
            ? [...closed, { type: "reasoning_delta", content: part.content }]
            : closed;
        }
        return [];
      }
      case ActionType.ChatDelta:
        return [{ type: "delta", messageId: action.partId, content: action.content ?? "" }];
      case ActionType.ChatReasoning:
        return [{ type: "reasoning_delta", content: action.content ?? "" }];
      case ActionType.ChatToolCallStart:
        return closeReply(currentParts(chat));
      case ActionType.ChatToolCallReady: {
        const call = findToolCall(chat, action.toolCallId!);
        return call ? toolStarted(call) : [];
      }
      case ActionType.ChatToolCallConfirmed:
        return action.approved === false
          ? toolEnd({
              type: "tool_end",
              toolCallId: action.toolCallId!,
              success: false,
              result: text(action.reasonMessage),
            })
          : [];
      case ActionType.ChatToolCallComplete:
        // A refused call is already cancelled; the host's later completion only tells the model.
        if (findToolCall(chat, action.toolCallId!)?.status === "cancelled") return [];
        return toolEnd({
          type: "tool_end",
          toolCallId: action.toolCallId!,
          success: action.result?.success ?? false,
          result: resultText(action.result ?? {}),
        });
      case ActionType.ChatTurnComplete:
      case ActionType.ChatTurnCancelled:
        // The host ends a steered turn and starts the next from its steering message.
        if (chat.steeringMessage) return closeReply(currentParts(chat));
        turnId = undefined;
        return [...closeReply(currentParts(chat)), { type: "end", reason: "idle" }];
      case ActionType.ChatError:
        turnId = undefined;
        return [
          ...closeReply(currentParts(chat)),
          {
            type: "end",
            reason: "error",
            error: action.part?.error?.message ?? "The remote turn failed.",
          },
        ];
      default:
        return [];
    }
  }

  /**
   * The events that bring the transcript from what was emitted up to `chat`: the rest of the
   * followed turn, its end if it finished, and a turn the host started from a steering message,
   * whose message the transcript already shows. A followed turn the host no longer has ended when
   * a restarted host lost it.
   */
  function catchUp(chat: NativeChat): SessionEvent[] {
    if (turnId === undefined) return [];
    const { activeTurn } = chat;
    if (activeTurn?.id === turnId) return catchUpParts(activeTurn.responseParts, true);
    const finished = chat.turns.find(({ id }) => id === turnId);
    if (!finished) {
      turnId = undefined;
      return [{ type: "end", reason: "error", error: "The agent host lost this run." }];
    }
    const events = catchUpParts(finished.responseParts, false);
    if (activeTurn) {
      turnId = activeTurn.id;
      return [...events, ...catchUpParts(activeTurn.responseParts, true)];
    }
    turnId = undefined;
    return [
      ...events,
      finished.state === "error"
        ? { type: "end", reason: "error", error: "The remote turn failed." }
        : { type: "end", reason: "idle" },
    ];
  }

  return { project, catchUp };
}

/** A chat's completed turns, as the events their live projection produced. */
export function projectTurns(turns: readonly NativeTurn[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const turn of turns) {
    events.push(messageEvent(turn.message, turn.id), { type: "status", status: "thinking" });
    for (const part of turn.responseParts) {
      if (part.kind === "markdown") {
        events.push({ type: "assistant_message", messageId: part.id, content: part.content ?? "" });
      } else if (part.kind === "reasoning" && part.content) {
        events.push({ type: "reasoning", content: part.content });
      } else if (part.kind === "toolCall" && part.toolCall) {
        const call = part.toolCall;
        events.push(toolStart(call));
        if (call.status === "completed") {
          events.push({
            type: "tool_end",
            toolCallId: call.toolCallId,
            success: call.success ?? false,
            result: resultText(call),
          });
        } else if (call.status === "cancelled") {
          events.push({
            type: "tool_end",
            toolCallId: call.toolCallId,
            success: false,
            result: text(call.reasonMessage),
          });
        }
      }
    }
    events.push(
      turn.state === "error" ? { type: "end", reason: "error" } : { type: "end", reason: "idle" },
    );
  }
  return events;
}

/** A native tool call's input as arguments; input that isn't a JSON object stays whole. */
export function toolArguments(input: unknown): { [key: string]: JSONType } {
  if (typeof input !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { [key: string]: JSONType })
      : { input };
  } catch {
    return { input };
  }
}

/** What the model read from a finished tool: its text, a shell's output, or its summary. */
export function resultText(
  result: Pick<NativeToolCall, "content" | "pastTenseMessage" | "error">,
): string {
  const content = (result.content ?? [])
    .map((item) =>
      item.type === "text"
        ? (item.text ?? "")
        : item.type === "terminal"
          ? (item.result?.preview ?? "")
          : "",
    )
    .filter(Boolean)
    .join("\n");
  return content || text(result.error?.message) || text(result.pastTenseMessage);
}

function messageEvent(message: NativeMessage, turnId: string): SessionEvent {
  const encoded = message._meta?.[SYSTEM_MESSAGE_META];
  const system = typeof encoded === "string" ? decodeSystemMessage(encoded) : undefined;
  return system
    ? { type: "system_message", content: system, clientId: turnId }
    : { type: "user_message", content: withoutInstructions(message.text), clientId: turnId };
}

function toolStart(call: NativeToolCall): SessionEvent {
  return {
    type: "tool_start",
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    arguments: toolArguments(call.toolInput),
  };
}

function withoutInstructions(text: string): string {
  if (!text.startsWith(INSTRUCTIONS_START)) return text;
  const end = text.indexOf(INSTRUCTIONS_END);
  return end < 0 ? text : text.slice(end + INSTRUCTIONS_END.length).trimStart();
}

function text(value: Text): string {
  if (typeof value === "string") return value;
  return value?.markdown ?? value?.value ?? "";
}
