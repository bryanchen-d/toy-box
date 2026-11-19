import type { Message } from "./index";

export function hasPendingSessionQuestion(
  session: { messages: readonly Message[] },
  requestId: string,
): boolean {
  return session.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some(
        (toolCall) =>
          toolCall.question?.state === "pending" && toolCall.question.requestId === requestId,
      ) === true,
  );
}

export function hasBlockingSessionQuestion(session: { messages: readonly Message[] }): boolean {
  return session.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some(
        (toolCall) =>
          toolCall.question?.state === "pending" && toolCall.question.blocking !== false,
      ) === true,
  );
}

/** The tool calls whose questions still await an answer. */
export function pendingSessionQuestionIds(session: { messages: readonly Message[] }): string[] {
  return session.messages.flatMap((message) =>
    message.role === "assistant"
      ? (message.toolCalls ?? [])
          .filter((toolCall) => toolCall.question?.state === "pending")
          .map(({ id }) => id)
      : [],
  );
}
