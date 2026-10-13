import { useEffect, useLayoutEffect, useRef } from "react";
import type { Attachment } from "@/shared/attachments/model";
import { useViewport } from "@/shared/hooks/useViewport";
import { useAttachments } from "./attachments/useAttachments";
import type { ComposerInputHandle } from "./input/ComposerInput";

/** What a composer sends: the draft's trimmed text and its images. */
export type ComposerMessage = { content: string; attachments?: Attachment[] };

/** Delivers a message; a returned promise that rejects hands the message back to the composer. */
type ComposerSend = (message: ComposerMessage) => void | Promise<unknown>;

export type ComposerDraft = ReturnType<typeof useComposerDraft>;

/** One message being written: host-owned text plus images, sent together and then cleared. */
export function useComposerDraft({
  value,
  onValueChange,
  onSend,
  disabled = false,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** Where Enter and the send button deliver the draft. */
  onSend: ComposerSend;
  disabled?: boolean;
}) {
  const inputRef = useRef<ComposerInputHandle>(null);
  const attachments = useAttachments();
  const { hydrated, isMobile } = useViewport();
  const canSubmit =
    !disabled &&
    attachments.pendingCount === 0 &&
    (value.trim() !== "" || attachments.items.length > 0);

  // Desktop composers take focus once ready; mobile waits for a tap rather than raising a keyboard.
  useEffect(() => {
    if (hydrated && !isMobile && !disabled) inputRef.current?.focus();
  }, [hydrated, isMobile, disabled]);

  // Edits can follow one another, or a send's settlement, before a render, so they build on the
  // draft as it is then.
  const current = useRef({ value, images: attachments.items.length });
  useLayoutEffect(() => {
    current.current = { value, images: attachments.items.length };
  });

  /** Replaces the text, which starts a new editing history. */
  function setValue(text: string) {
    current.current = { ...current.current, value: text };
    onValueChange(text);
  }

  /** Puts messages back after the draft's text and images, such as queued input to edit. */
  function append(...messages: ComposerMessage[]) {
    if (messages.length === 0) return;
    setValue(
      [current.current.value, ...messages.map(({ content }) => content)]
        .filter((text) => text.trim())
        .join("\n\n"),
    );
    attachments.append(messages.flatMap((message) => message.attachments ?? []));
  }

  /** Sends the draft as one message, to `onSend` unless given elsewhere, and starts the next. */
  function submit(send: ComposerSend = onSend): boolean {
    if (!canSubmit || inputRef.current?.isComposing()) return false;
    const message = {
      content: value.trim(),
      attachments: attachments.items.length > 0 ? attachments.items : undefined,
    };
    const delivery = send(message);
    setValue("");
    attachments.clear();
    inputRef.current?.focus();
    // A failed message returns to the composer, unless another has been started since.
    void Promise.resolve(delivery).catch(() => {
      if (!current.current.value.trim() && current.current.images === 0) append(message);
    });
    return true;
  }

  return {
    value,
    attachments,
    canSubmit,
    setValue,
    append,
    submit,
    focus: () => inputRef.current?.focus(),
    inputProps: {
      ref: inputRef,
      onValueChange: setValue,
      disabled,
      onPaste: attachments.handlePaste,
    },
  };
}
