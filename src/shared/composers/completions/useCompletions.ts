import {
  useId,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { skipToken, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import type { ComposerSelection } from "../input/ComposerInput";

type CompletionMatch = { start: number; end: number; query: string };
/** One completion a menu offers. Accepting it inserts its value unless its source says otherwise. */
export type CompletionItem = {
  value: string;
  label: string;
  /** Muted text beside the label, such as where the item is. */
  detail?: string;
  /** A second line saying what the item is or does. */
  description?: string;
  /** Consecutive items in a group are listed under its heading. */
  group?: string;
};
export type CompletionSource<Item extends CompletionItem = CompletionItem> = {
  id: string;
  /** A token pattern ending where the token ends: a one-character trigger, then the query as its first capture. */
  trigger: RegExp;
  /** The items matching a query, given immediately or by a query. */
  query: (text: string) => Item[] | CompletionQuery<Item>;
  /** What the menu says when no item matches. */
  empty: string;
  debounceMs?: number;
  /** The text an accepted item inserts, if not its value. A promise defers insertion, such as to create what it names. */
  accept?: (item: Item) => string | Promise<string>;
};
/** A query whose selected data is the items; what it fetches is the source's own concern. */
type CompletionQuery<Item> = UseQueryOptions<any, Error, Item[], any>;
type ActiveCompletion = CompletionMatch & { source: string; selection: ComposerSelection };
type Interaction = {
  completion: ActiveCompletion;
  dismissed: boolean;
  index: number;
  /** Why accepting an item failed. */
  error?: Error;
};

export type Completions<Item extends CompletionItem = CompletionItem> = ReturnType<
  typeof useCompletions<Item>
>;

/** A trigger character at the start or after whitespace, completing the word that follows it. */
export function wordTrigger(character: string): RegExp {
  const escaped = character.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(?:^|\\s)${escaped}([^\\s${escaped}]*)`);
}

/** Shared query matching and menu navigation; insertion uses the input's native text range. */
export function useCompletions<Item extends CompletionItem>(
  sources: readonly CompletionSource<Item>[],
) {
  const menuId = useId();
  const [interaction, setInteraction] = useState<Interaction>();
  const active = interaction?.dismissed ? undefined : interaction?.completion;
  const source = active && sources.find((source) => source.id === active.source);
  const text = active?.query ?? "";
  const [debouncedText] = useDebouncedValue(text, { wait: source?.debounceMs ?? 0 });
  const queryText = source?.debounceMs ? debouncedText : text;
  const request = source?.query(queryText);
  const options = Array.isArray(request) ? undefined : request;
  const result = useQuery({
    ...(options ?? { queryKey: ["completions", "inactive"], queryFn: skipToken }),
    enabled: !!options && text === queryText,
    // A single observer retains items while a search changes its key; the source tag keeps one
    // source's items (and raw data shape) from standing in for another's.
    meta: { ...options?.meta, completionSource: source?.id },
    placeholderData: (previous, query) =>
      query?.meta?.completionSource === source?.id ? previous : undefined,
    throwOnError: true,
  });
  const items = Array.isArray(request) ? request : (result.data ?? []);
  const count = items.length;
  const activeIndex = Math.min(interaction?.index ?? 0, Math.max(count - 1, 0));
  const pending = !!options && (text !== queryText || result.isPending || result.isPlaceholderData);

  // Events can outrun rendering, so acceptance checks the latest interaction, not a closure's.
  const latest = useRef(interaction);
  /** An asynchronous acceptance holds off others until it settles. */
  const accepting = useRef(false);
  function update(next: Interaction | undefined) {
    latest.current = next;
    setInteraction(next);
  }
  const isLatest = (completion: ActiveCompletion | undefined): completion is ActiveCompletion =>
    !!completion && !latest.current?.dismissed && latest.current?.completion === completion;
  const isMenuGesture = useMenuBoundary(menuId, () => update(undefined));

  /** Follows the input's selection, unless a menu gesture briefly took it. */
  function track(selection: ComposerSelection | undefined) {
    if (!selection && isMenuGesture()) return;
    const completion = selection && findCompletion(sources, selection);
    const previous = latest.current;
    if (!completion) update(undefined);
    else if (!previous || !sameCompletion(previous.completion, completion))
      update({ completion, dismissed: false, index: 0 });
  }
  function setActiveIndex(index: number) {
    if (latest.current) update({ ...latest.current, index });
  }
  function insert(completion: ActiveCompletion, text: string) {
    if (!isLatest(completion)) return;
    const { selection, start, end } = completion;
    if (selection.replace(start, end, `${text} `)) update(undefined);
  }
  // Validated before a source's own side effects, and again before a deferred insertion.
  function accept(item: Item) {
    if (pending || accepting.current || !isLatest(active)) return;
    const completion = active;
    const text = source?.accept ? source.accept(item) : item.value;
    if (typeof text === "string") return insert(completion, text);
    accepting.current = true;
    if (latest.current?.error) update({ ...latest.current, error: undefined });
    void text
      .then(
        (text) => insert(completion, text),
        (error: unknown) => {
          if (!isLatest(completion)) return;
          update({
            ...latest.current!,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        },
      )
      .finally(() => {
        accepting.current = false;
      });
  }

  /** Menu navigation and acceptance, which prevent the keys' default. */
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!active) return;
    if (count > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setActiveIndex((activeIndex + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
    } else if (
      (count > 0 || pending) &&
      !event.shiftKey &&
      (event.key === "Enter" || event.key === "Tab")
    ) {
      event.preventDefault();
      if (count > 0) accept(items[activeIndex]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      if (latest.current) update({ ...latest.current, dismissed: true });
    }
  }

  return {
    /** The source whose completion is open. */
    source,
    items,
    pending,
    error: active && interaction?.error,
    activeIndex,
    inputProps: {
      onSelectionChange: track,
      "aria-autocomplete": "list" as const,
      "aria-controls": menuId,
      "aria-activedescendant": active && count > 0 ? `${menuId}-${activeIndex}` : undefined,
    },
    menuProps: { id: menuId, role: "listbox" },
    itemProps: (index: number) => ({
      id: `${menuId}-${index}`,
      role: "option",
      "aria-selected": index === activeIndex,
      "aria-disabled": pending || undefined,
      ref:
        index === activeIndex
          ? (element: HTMLElement | null) => element?.scrollIntoView({ block: "nearest" })
          : undefined,
      onMouseEnter: () => setActiveIndex(index),
      onMouseDown: (event: MouseEvent<HTMLElement>) => {
        // Touch taps synthesize mousedown after pointerup; keep focus until click accepts.
        if (event.button === 0) event.preventDefault();
      },
      onClick: () => accept(items[index]!),
    }),
    handleKeyDown,
  };
}

/**
 * A completion ends when interaction leaves its input and menu. A menu gesture, such as a tap
 * or touch scroll, may briefly take the caret without ending it; the returned predicate says so.
 * Focus that a gesture moved into the menu ends it on leaving, without the input blurring again.
 */
function useMenuBoundary(menuId: string, onLeave: () => void) {
  const gesture = useRef(false);
  const leave = useEffectEvent(onLeave);
  useEffect(() => {
    const inMenu = (target: EventTarget | null) =>
      target instanceof Node && !!document.getElementById(menuId)?.contains(target);
    const pointerDown = ({ target }: Event) => {
      gesture.current = inMenu(target);
      if (!gesture.current) leave();
    };
    const pointerEnd = () => {
      gesture.current = false;
    };
    const focusIn = ({ target }: Event) => {
      const inInput = target instanceof Element && target.getAttribute("aria-controls") === menuId;
      if (!inInput && !inMenu(target)) leave();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    document.addEventListener("pointerup", pointerEnd, true);
    document.addEventListener("pointercancel", pointerEnd, true);
    document.addEventListener("focusin", focusIn);
    return () => {
      document.removeEventListener("pointerdown", pointerDown, true);
      document.removeEventListener("pointerup", pointerEnd, true);
      document.removeEventListener("pointercancel", pointerEnd, true);
      document.removeEventListener("focusin", focusIn);
    };
  }, [menuId]);
  return () =>
    gesture.current || !!document.getElementById(menuId)?.contains(document.activeElement);
}

function findCompletion(
  sources: readonly Pick<CompletionSource, "id" | "trigger">[],
  selection: ComposerSelection,
): ActiveCompletion | undefined {
  for (const source of sources) {
    const match = matchCompletion(source.trigger, selection.text, selection.caret);
    if (match) return { source: source.id, selection, ...match };
  }
}

export function matchCompletion(
  trigger: RegExp,
  context: string,
  caret: number,
): CompletionMatch | undefined {
  const pattern = new RegExp(
    trigger,
    trigger.flags.includes("g") ? trigger.flags : `${trigger.flags}g`,
  );
  for (const match of context.matchAll(pattern)) {
    const end = match.index + match[0].length;
    const start = end - match[1]!.length - 1;
    if (caret > start && caret <= end)
      return { start, end, query: context.slice(start + 1, caret) };
  }
}

function sameCompletion(left: ActiveCompletion, right: ActiveCompletion): boolean {
  return (
    left.source === right.source &&
    left.selection.key === right.selection.key &&
    left.start === right.start &&
    left.end === right.end &&
    left.query === right.query
  );
}
