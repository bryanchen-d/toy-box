// Process-local saved drafts, one per composer, kept for a day after their last edit.

import type { DraftKey, SavedDraft, SavedDrafts } from "@workspace/model/state/drafts";
import { sharedMap } from "@/shared/server/processState";

const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const drafts = sharedMap<SavedDraft>("workspace-drafts");

export function getSavedDrafts(now: number = Date.now()): SavedDrafts {
  const result: SavedDrafts = {};
  for (const [key, draft] of drafts) {
    if (now - draft.updatedAt >= DRAFT_TTL_MS) drafts.delete(key);
    else result[key as DraftKey] = draft;
  }
  return result;
}

/** Stamps a client's edit with server time; null when it changes nothing. */
export function saveDraft(
  key: DraftKey,
  text: string,
  origin: string,
  now: number = Date.now(),
): SavedDraft | null {
  const current = drafts.get(key);
  if (current?.text === text && current.origin === origin) return null;
  const draft = { text, origin, updatedAt: now };
  drafts.set(key, draft);
  return draft;
}

export function deleteSavedDraft(key: DraftKey): void {
  drafts.delete(key);
}
