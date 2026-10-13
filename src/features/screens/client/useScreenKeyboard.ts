import { useEffect, useEffectEvent, useRef } from "react";
import type { ScreenInput } from "../model";
import type { useScreen } from "./useScreen";

/**
 * Keyboard input on a screen while in control. The focused canvas sends physical keys and
 * pastes. On a phone, focusing a hidden textarea brings up the keyboard, and what it types
 * arrives as input events instead.
 */
export function useScreenKeyboard({ canvasRef, hasControl, input }: ReturnType<typeof useScreen>) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const send = useEffectEvent(input);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textarea = textareaRef.current;
    if (!hasControl || !canvas || !textarea) return;
    return routeKeys(canvas, textarea, send);
  }, [canvasRef, hasControl]);

  return {
    textareaRef,
    showKeyboard: () => textareaRef.current?.focus({ preventScroll: true }),
  };
}

/** Sends the canvas's keys and pastes, and what the textarea types, until the cleanup. */
function routeKeys(
  canvas: HTMLCanvasElement,
  textarea: HTMLTextAreaElement,
  send: (actions: ScreenInput[]) => void,
): () => void {
  /** Keys pressed on the host, so that only their releases follow. */
  const pressed = new Set<string>();
  let composing = false;
  let composed: ReturnType<typeof setTimeout> | undefined;

  function onKeyDown(event: KeyboardEvent) {
    if (composing || event.isComposing) return;
    if (event.currentTarget === textarea && typesText(event)) return;
    event.preventDefault();
    event.stopPropagation(); // Keep the workspace's shortcuts out of it.
    pressed.add(event.code);
    send([{ type: "key", code: event.code, down: true }]);
  }
  function onKeyUp({ code }: KeyboardEvent) {
    if (pressed.delete(code)) send([{ type: "key", code, down: false }]);
  }
  function onPaste(event: ClipboardEvent) {
    event.preventDefault();
    const text = event.clipboardData?.getData("text/plain");
    if (text) send([{ type: "text", text }]);
  }
  // Clicking the canvas focuses it for physical keys, unless the phone keyboard is up.
  function onPointerDown() {
    if (document.activeElement !== textarea) canvas.focus({ preventScroll: true });
  }

  /** Sends what the textarea holds, then empties it for the next input. */
  function sendTyped(inputType = "insertText") {
    const actions = typedInput(inputType, textarea.value);
    textarea.value = TEXTAREA_ANCHOR;
    if (actions.length) send(actions);
  }
  function onInput(event: Event) {
    const { inputType, isComposing } = event as InputEvent;
    if (!composing && !isComposing) sendTyped(inputType);
  }
  function onCompositionStart() {
    composing = true;
  }
  function onCompositionEnd() {
    // The composition's last input event follows this one; send once it has landed.
    clearTimeout(composed);
    composed = setTimeout(() => {
      composing = false;
      sendTyped();
    });
  }

  textarea.value = TEXTAREA_ANCHOR;
  const listening = new AbortController();
  const { signal } = listening;
  canvas.addEventListener("pointerdown", onPointerDown, { signal });
  canvas.addEventListener("keydown", onKeyDown, { signal });
  canvas.addEventListener("paste", onPaste, { signal });
  window.addEventListener("keyup", onKeyUp, { signal });
  textarea.addEventListener("keydown", onKeyDown, { signal });
  textarea.addEventListener("input", onInput, { signal });
  textarea.addEventListener("compositionstart", onCompositionStart, { signal });
  textarea.addEventListener("compositionend", onCompositionEnd, { signal });
  return () => {
    listening.abort();
    clearTimeout(composed);
  };
}

/** Whether a textarea key types text, which arrives as an input event instead. */
function typesText(event: KeyboardEvent) {
  return (
    !event.code || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)
  );
}

/** An emptied textarea keeps one invisible character, so that Backspace still produces input. */
export const TEXTAREA_ANCHOR = "\u200b";

/** The host input for one input event on the textarea: an editing key, or the text typed. */
export function typedInput(inputType: string, value: string): ScreenInput[] {
  const key = EDITING_KEYS[inputType];
  if (key)
    return [
      { type: "key", code: key, down: true },
      { type: "key", code: key, down: false },
    ];
  const text = value.startsWith(TEXTAREA_ANCHOR) ? value.slice(TEXTAREA_ANCHOR.length) : value;
  return text ? [{ type: "text", text }] : [];
}

const EDITING_KEYS: Record<string, string | undefined> = {
  deleteContentBackward: "Backspace",
  deleteContentForward: "Delete",
  insertLineBreak: "Enter",
  insertParagraph: "Enter",
};
