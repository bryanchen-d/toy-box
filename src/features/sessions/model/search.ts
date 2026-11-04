import type { Message } from "./index";
import { systemMessageLabel } from "./systemMessages";
import {
  createMessageSearchMatcher,
  MESSAGE_SEARCH_LIMIT,
  type MessageSearchMatch,
} from "@/shared/messages/search";

export type SessionMessageMatch = MessageSearchMatch & {
  messageIndex: number;
  role: Message["role"];
};

/** Search canonical message text, not tool output or provider-only metadata. */
export function searchSessionMessages(
  messages: readonly Message[],
  query: string,
): SessionMessageMatch[] {
  const findMatch = createMessageSearchMatcher(query);
  const matches: SessionMessageMatch[] = [];
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex];
    const content =
      message.role === "system" ? systemMessageLabel(message.content) : message.content;
    const match = findMatch(content);
    if (!match) continue;
    matches.push({
      messageIndex,
      role: message.role,
      ...match,
    });
    if (matches.length === MESSAGE_SEARCH_LIMIT) break;
  }
  return matches;
}
