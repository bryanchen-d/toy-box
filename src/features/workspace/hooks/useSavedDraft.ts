import { useEffect, useRef, useState } from "react";
import { useDebouncer } from "@tanstack/react-pacer/debouncer";
import { getOrCreateClientId } from "@workspace/model/config/clientId";
import type { DraftKey, SavedDraft } from "@workspace/model/state/drafts";
import { useDispatchWorkspaceAction, useWorkspaceSelector } from "./state";

const DRAFT_SYNC_DELAY_MS = 1500;

/**
 * One composer's draft text, shared across clients. Edits apply locally and debounce out;
 * another client's edits are adopted, while this client's own echoes are not. A cleared draft
 * syncs at once, and pending edits flush when the composer unmounts.
 */
export function useSavedDraft(key: DraftKey) {
  const shared = useWorkspaceSelector((workspace) => workspace.drafts[key] ?? null);
  const [origin] = useState(getOrCreateClientId);
  const dispatchWorkspaceAction = useDispatchWorkspaceAction();
  const [value, setValue] = useState("");
  const edited = useRef(false);
  const synced = useRef<string | null>(null);
  const sync = useDebouncer(
    (text: string) => {
      if (synced.current === text) return;
      synced.current = text;
      dispatchWorkspaceAction({
        type: "draft.changed",
        key,
        draft: { text, origin, updatedAt: Date.now() },
      });
    },
    { wait: DRAFT_SYNC_DELAY_MS, onUnmount: (debouncer) => debouncer.flush() },
  );

  function onValueChange(text: string) {
    edited.current = true;
    setValue(text);
    sync.maybeExecute(text);
    if (text === "") sync.flush();
  }

  useEffect(() => {
    if (!shouldAdoptSavedDraft(shared, origin, edited.current)) return;
    const text = shared?.text ?? "";
    setValue(text);
    sync.cancel();
    synced.current = text;
  }, [origin, shared, sync]);

  return { value, onValueChange };
}

export function shouldAdoptSavedDraft(
  shared: SavedDraft | null,
  origin: string,
  hasLocalEdit: boolean,
): boolean {
  return !hasLocalEdit || (shared !== null && shared.origin !== origin);
}
