import type { Message } from "../../model";

type TranscriptRow =
  | { key: string; message: Message | undefined; messageIndex: number }
  | { key: string; message?: never; messageIndex?: never };

export function createTranscriptRows(
  messageCount: number,
  getMessage: (index: number) => Message | undefined,
  hiddenIndices: readonly number[],
) {
  const count = messageCount - hiddenIndices.length;
  const messageIndexAt = (index: number) => {
    let messageIndex = index;
    for (const hidden of hiddenIndices) {
      if (hidden > messageIndex) break;
      messageIndex++;
    }
    return messageIndex;
  };
  return {
    length: count + 1,
    at(index: number): TranscriptRow {
      if (index < 0) index += count + 1;
      if (index === count) {
        // Follow the last rendered identity, not raw count: an empty assistant
        // gaining its first text/tool must advance the activity anchor too.
        return { key: `activity-${count ? messageIndexAt(count - 1) : "empty"}` };
      }
      const messageIndex = messageIndexAt(index);
      return {
        key: `message-${messageIndex}`,
        messageIndex,
        message: getMessage(messageIndex),
      };
    },
  };
}
