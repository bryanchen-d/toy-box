import type { Message } from "../../model";

type TranscriptRow =
  | { key: string; message: Message; messageIndex: number }
  | { key: string; message?: never; messageIndex?: never };

export function createTranscriptRows(messages: readonly Message[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    if (
      message.role === "assistant" &&
      !message.content &&
      !message.error &&
      !message.toolCalls?.length
    ) {
      continue;
    }
    rows.push({ key: `${message.role}-${messageIndex}`, message, messageIndex });
  }
  // A hidden assistant can become visible without changing the message count.
  // Follow the last rendered message so that transition also advances the tail.
  rows.push({ key: `activity-${rows.at(-1)?.key ?? "empty"}` });
  return rows;
}
