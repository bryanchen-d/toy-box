import { z } from "zod";

export const MESSAGE_SEARCH_LIMIT = 20;
export const MESSAGE_SEARCH_QUERY_LIMIT = 500;
export const messageSearchQuerySchema = z.string().trim().min(1).max(MESSAGE_SEARCH_QUERY_LIMIT);

export type MessageSearchMatch = {
  before: string;
  match: string;
  after: string;
};

/** Compile a literal, case-insensitive search and retain offsets in the original text. */
export function createMessageSearchMatcher(query: string) {
  const text = query.trim();
  const pattern = text ? new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu") : undefined;
  return (content: string): MessageSearchMatch | undefined => {
    const match = pattern?.exec(content);
    if (!match) return undefined;
    const start = Math.max(0, match.index - 60);
    const matchEnd = match.index + match[0].length;
    const end = Math.min(content.length, matchEnd + 100);
    return {
      before: (start ? "..." : "") + content.slice(start, match.index),
      match: match[0],
      after: content.slice(matchEnd, end) + (end < content.length ? "..." : ""),
    };
  };
}
