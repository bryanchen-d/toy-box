import { describe, expect, test } from "bun:test";
import type { SavedDraft } from "@workspace/model/state/drafts";
import { shouldAdoptSavedDraft } from "./useSavedDraft";

function draft(text: string, origin: string): SavedDraft {
  return { text, origin, updatedAt: Date.now() };
}

describe("saved draft adoption", () => {
  test("applies initial and remote drafts but suppresses own echoes", () => {
    const origin = "client-a";

    expect(shouldAdoptSavedDraft(draft("initial", origin), origin, false)).toBe(true);
    expect(shouldAdoptSavedDraft(draft("own echo", origin), origin, true)).toBe(false);
    expect(shouldAdoptSavedDraft(draft("remote edit", "client-b"), origin, true)).toBe(true);
    expect(shouldAdoptSavedDraft(draft("", "client-b"), origin, true)).toBe(true);
  });

  test("ignores missing server state after local edits but adopts it before editing", () => {
    expect(shouldAdoptSavedDraft(null, "client-a", false)).toBe(true);
    expect(shouldAdoptSavedDraft(null, "client-a", true)).toBe(false);
  });
});
