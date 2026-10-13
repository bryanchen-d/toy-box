import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from "react";
import { useHydrated } from "@tanstack/react-router";
import { cn } from "@/shared/utils";
import {
  composerContents,
  composerInputDeletion,
  composerSelection,
  composerValue,
  focusComposer,
  insertComposerText,
  prepareComposer,
  selectedComposerRange,
  selectedComposerText,
  type ComposerReferences,
  type ComposerSelection,
} from "./dom";

export type { ComposerReferences, ComposerSelection } from "./dom";
export type ComposerInputHandle = {
  focus: () => void;
  isComposing: () => boolean;
};
type Props = Omit<
  ComponentProps<"div">,
  "children" | "onChange" | "onSelect" | "defaultValue" | "ref"
> & {
  ref?: Ref<ComposerInputHandle>;
  value: string;
  onValueChange: (value: string) => void;
  /** The caret's editable text run; undefined while unfocused, composing, or on a reference. */
  onSelectionChange?: (selection: ComposerSelection | undefined) => void;
  onOverflowChange?: (overflowing: boolean) => void;
  references?: ComposerReferences;
  placeholder?: string;
  disabled?: boolean;
};
const noReferences: ComposerReferences = () => undefined;

/**
 * Native DOM owns editing and undo; this component bridges the host's string value. Edits publish
 * the editor's text. A different host value is adopted by remounting the editor, which starts a
 * new undo history, and waits while IME composition owns the text. Focus requested before the
 * editor can take it is applied once it can.
 */
export function ComposerInput({
  ref,
  value,
  onValueChange,
  onSelectionChange,
  onOverflowChange,
  references = noReferences,
  placeholder,
  disabled = false,
  className,
  onKeyDown,
  onPaste,
  ...props
}: Props) {
  const hydrated = useHydrated();
  const editorRef = useRef<HTMLDivElement>(null);
  /** The editor element whose contents show `published`; null until a remount is populated. */
  const populated = useRef<HTMLDivElement | null>(null);
  /** The text the editor holds: its last published edit or the last adopted host value. */
  const published = useRef(value);
  const composing = useRef(false);
  /** A host value that arrived mid-composition, adopted when composition ends. */
  const deferred = useRef<string | null>(null);
  const focusPending = useRef(false);
  /** Keys the editor element; each adoption mounts a fresh one. */
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string>();

  function focus() {
    const editor = editorRef.current;
    if (disabled) return;
    if (!editor?.isContentEditable || populated.current !== editor || composing.current) {
      focusPending.current = true;
      return;
    }
    focusPending.current = false;
    focusComposer(editor);
    reportSelection();
  }
  function reportSelection() {
    const editor = editorRef.current;
    if (!onSelectionChange) return;
    onSelectionChange(editor && !composing.current ? composerSelection(editor, insert) : undefined);
  }
  function adopt(text: string) {
    published.current = text;
    if (composing.current) {
      deferred.current = text;
      return;
    }
    focusPending.current = focusPending.current || editorRef.current === document.activeElement;
    populated.current = null;
    setRevision((current) => current + 1);
    setError(undefined);
  }
  function populate(editor: HTMLDivElement) {
    editor.replaceChildren(composerContents(editor.ownerDocument, value, references));
    prepareComposer(editor);
    populated.current = editor;
    if (!focusPending.current) reportSelection();
  }
  // After every render, since the host may write its value at any time.
  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (value !== published.current) adopt(value);
    else if (editor && populated.current !== editor) populate(editor);
    if (focusPending.current && hydrated && !composing.current) focus();
  });
  const selectionChanged = useEffectEvent(() => {
    if (document.activeElement === editorRef.current) reportSelection();
  });
  useEffect(() => {
    document.addEventListener("selectionchange", selectionChanged);
    return () => document.removeEventListener("selectionchange", selectionChanged);
  }, []);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor || !onOverflowChange) return;
    const measure = () => onOverflowChange(editor.scrollHeight > editor.clientHeight + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(editor);
    measure();
    return () => observer.disconnect();
  }, [revision, onOverflowChange]);

  function publish() {
    const editor = editorRef.current;
    if (!editor) return;
    prepareComposer(editor);
    const text = composerValue(editor);
    editor.dataset.empty = String(!text);
    onOverflowChange?.(editor.scrollHeight > editor.clientHeight + 1);
    if (composing.current && deferred.current !== null) return;
    if (text !== published.current) {
      published.current = text;
      setError(undefined);
      onValueChange(text);
    }
    reportSelection();
  }
  function insert(range: Range, text: string): boolean {
    const editor = editorRef.current;
    if (!editor || disabled || composing.current || !editor.contains(range.commonAncestorContainer))
      return false;
    const applied = insertComposerText(editor, range, text, references);
    if (!applied) {
      setError("The browser could not edit this message. Your draft has been kept.");
      return false;
    }
    setError(undefined);
    publish();
    return true;
  }
  const beforeInput = useEffectEvent((event: InputEvent) => {
    const editor = editorRef.current;
    if (
      !editor ||
      event.currentTarget !== editor ||
      composing.current ||
      event.isComposing ||
      !event.cancelable
    )
      return;
    if (event.inputType.startsWith("delete")) {
      const range = composerInputDeletion(editor, event);
      if (range) {
        event.preventDefault();
        insert(range, "");
      }
    }
    // One guard for shortcuts, menus, and mobile callouts: drafts are plain text.
    else if (event.inputType.startsWith("format")) event.preventDefault();
  });
  useEffect(() => {
    const editor = editorRef.current;
    editor?.addEventListener("beforeinput", beforeInput);
    return () => editor?.removeEventListener("beforeinput", beforeInput);
  }, [revision]);

  function insertAtSelection(text: string) {
    const editor = editorRef.current;
    const range = editor && selectedComposerRange(editor);
    if (range) insert(range, text);
  }
  useImperativeHandle(ref, () => ({ focus, isComposing: () => composing.current }));
  function copy(event: React.ClipboardEvent<HTMLDivElement>, cut: boolean) {
    const range = selectedComposerRange(event.currentTarget);
    if (!range || range.collapsed) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", selectedComposerText(event.currentTarget, range));
    if (cut) insert(range, "");
  }
  return (
    <div className="w-full min-w-0">
      <div
        {...props}
        key={revision}
        ref={editorRef}
        role="textbox"
        aria-placeholder={placeholder}
        aria-multiline
        aria-disabled={disabled || !hydrated || undefined}
        contentEditable={hydrated && !disabled}
        suppressContentEditableWarning
        suppressHydrationWarning
        tabIndex={disabled || !hydrated ? -1 : 0}
        data-slot="input-group-control"
        data-empty={String(!value)}
        data-placeholder={placeholder}
        className={cn(
          "relative w-full min-h-[calc(1lh+1rem)] max-h-[calc(3lh+1rem)] overflow-y-auto px-3 py-2 text-sm leading-6 whitespace-pre-wrap wrap-anywhere outline-none",
          "data-[empty=true]:before:pointer-events-none data-[empty=true]:before:absolute data-[empty=true]:before:text-muted-foreground data-[empty=true]:before:content-[attr(data-placeholder)]",
          "[&_[data-composer-reference]]:select-all",
          "[&_[data-composer-reference]+[data-composer-caret]:empty]:inline-block [&_[data-composer-reference]+[data-composer-caret]:empty]:w-px [&_[data-composer-reference]+[data-composer-caret]:empty]:h-[1lh] [&_[data-composer-reference]+[data-composer-caret]:empty]:align-bottom",
          disabled && "cursor-not-allowed opacity-50",
          className,
        )}
        onInput={publish}
        onFocus={reportSelection}
        onBlur={reportSelection}
        onCompositionStart={() => {
          composing.current = true;
          reportSelection();
        }}
        onCompositionEnd={() => {
          composing.current = false;
          const hostValue = deferred.current;
          deferred.current = null;
          if (hostValue !== null) adopt(hostValue);
          else publish();
          if (focusPending.current) focus();
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          onKeyDown?.(event);
          if (!event.defaultPrevented && event.key === "Enter") {
            event.preventDefault();
            insertAtSelection("\n");
          }
        }}
        onCopy={(event) => copy(event, false)}
        onCut={(event) => copy(event, true)}
        onPaste={(event) => {
          onPaste?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n");
          if (text) insertAtSelection(text);
        }}
        onDrop={(event) => event.preventDefault()}
      />
      {error && (
        <p role="alert" className="px-3 pb-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
