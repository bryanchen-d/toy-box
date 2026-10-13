import { describe, expect, onTestFinished, test } from "bun:test";
import type { DraftKey } from "@workspace/model/state/drafts";
import { deleteSavedDraft, getSavedDrafts, saveDraft } from "./drafts";

const DAY_MS = 24 * 60 * 60 * 1000;

function draftKey(): DraftKey {
  const key: DraftKey = `channel:${crypto.randomUUID()}`;
  onTestFinished(() => deleteSavedDraft(key));
  return key;
}

describe("workspace draft storage", () => {
  test("stamps a client's draft with server time and ignores its repeated update", () => {
    const key = draftKey();

    expect(saveDraft(key, "hello", "client-a", 1)).toEqual({
      text: "hello",
      origin: "client-a",
      updatedAt: 1,
    });
    expect(saveDraft(key, "hello", "client-a", 2)).toBeNull();
    expect(saveDraft(key, "hello", "client-b", 3)).toEqual({
      text: "hello",
      origin: "client-b",
      updatedAt: 3,
    });
    expect(getSavedDrafts(3)[key]).toEqual({ text: "hello", origin: "client-b", updatedAt: 3 });
  });

  test("expires a draft a day after its last edit", () => {
    const key = draftKey();

    saveDraft(key, "old", "client-a", 1);
    expect(getSavedDrafts(DAY_MS)[key]).toBeDefined();
    expect(getSavedDrafts(DAY_MS + 1)[key]).toBeUndefined();
  });

  test("deletes one composer's draft", () => {
    const key = draftKey();
    const other = draftKey();

    saveDraft(key, "mine", "client-a");
    saveDraft(other, "theirs", "client-a");
    deleteSavedDraft(key);
    expect(getSavedDrafts()[key]).toBeUndefined();
    expect(getSavedDrafts()[other]?.text).toBe("theirs");
  });
});
