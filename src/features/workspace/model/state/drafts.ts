import { z } from "zod";

/** The composer a saved draft belongs to. */
export const draftKeySchema = z.union([
  z.templateLiteral(["session:", z.string().min(1)]),
  z.templateLiteral(["channel:", z.string().min(1)]),
  z.literal("inbox"),
]);
export type DraftKey = z.infer<typeof draftKeySchema>;

/**
 * One composer's unsent text, saved in the workspace so every client sees it until it expires.
 * Sending or clearing saves empty text rather than deleting the draft: other clients, including
 * ones reconnecting later, clear too, while the client that cleared it ignores its own echo.
 */
export const savedDraftSchema = z.object({
  text: z.string().max(64 * 1024),
  /** The client that wrote it, so a client can tell its own echoes from other clients' edits. */
  origin: z.string().min(1).max(128),
  updatedAt: z.number(),
});
export type SavedDraft = z.infer<typeof savedDraftSchema>;

export type SavedDrafts = Partial<Record<DraftKey, SavedDraft>>;

/** The session a draft belongs to, when it is a session's. */
export function draftSessionId(key: DraftKey): string | undefined {
  return key.startsWith("session:") ? key.slice("session:".length) : undefined;
}

export function sameSavedDraft(left: SavedDraft | undefined, right: SavedDraft): boolean {
  return (
    left?.text === right.text && left.origin === right.origin && left.updatedAt === right.updatedAt
  );
}
