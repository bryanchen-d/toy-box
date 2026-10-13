import type { ComponentProps, KeyboardEvent, ReactNode } from "react";
import { ArrowUp, Image } from "lucide-react";
import { InputGroup, InputGroupAddon, InputGroupButton } from "@/shared/ui/input-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";
import { ImageAttachments } from "./attachments/ImageAttachments";
import {
  useCompletions,
  type CompletionItem,
  type CompletionSource,
  type Completions,
} from "./completions/useCompletions";
import { ComposerInput, type ComposerReferences } from "./input/ComposerInput";
import { TypingEffect } from "./typing-effect/TypingEffect";
import type { ComposerDraft } from "./useComposerDraft";

/** What a draft can complete, and how its menu looks. */
type ComposerCompletions<Item extends CompletionItem> = {
  /** The composer matches, navigates, and inserts from these. */
  sources: readonly CompletionSource<Item>[];
  /** Renders the open completion above the input, usually as a `CompletionMenu`. */
  menu: (completions: Completions<Item>) => ReactNode;
};

const noCompletions = { sources: [], menu: () => null };

/** The shared message composer: images, text, and a toolbar, with host-owned controls. */
export function Composer<Item extends CompletionItem>({
  draft,
  label,
  placeholder,
  tray,
  completions: { sources, menu } = noCompletions,
  references,
  controls,
  actions,
  onKeyDown,
  onOverflowChange,
  inputClassName,
}: {
  draft: ComposerDraft;
  /** The input's accessible name. */
  label: string;
  placeholder?: string;
  /** Docked above the input, such as outputs and queued messages. */
  tray?: ReactNode;
  completions?: ComposerCompletions<Item>;
  /** Which references in the draft appear as pills; the rest stay text. */
  references?: ComposerReferences;
  /** Toolbar controls after the attach button. */
  controls?: ReactNode;
  /** Toolbar actions at the trailing edge, ending with the send control. */
  actions: ReactNode;
  /** Keys for the host, after an open menu's and before the composer's own. */
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  onOverflowChange?: (overflowing: boolean) => void;
  /** Overrides the input's sizing, such as for an expanded editor. */
  inputClassName?: string;
}) {
  const { attachments } = draft;
  const completions = useCompletions(sources);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        draft.submit();
      }}
      {...attachments.dropTargetProps}
      className="@container w-full"
      suppressHydrationWarning
    >
      <input {...attachments.fileInputProps} suppressHydrationWarning />
      {tray}
      <InputGroup className={cn(attachments.isDragging && "border-ring ring-[3px] ring-ring/50")}>
        <ImageAttachments
          attachments={attachments.items}
          pendingCount={attachments.pendingCount}
          isDragging={attachments.isDragging}
          onRemove={attachments.remove}
        />
        {menu(completions)}
        <ComposerInput
          {...completions.inputProps}
          {...draft.inputProps}
          value={draft.value}
          aria-label={label}
          placeholder={placeholder}
          references={references}
          onOverflowChange={onOverflowChange}
          className={inputClassName}
          onKeyDown={(event) => {
            // An open menu takes keys first, then the host, then the composer's conventions.
            completions.handleKeyDown(event);
            if (!event.defaultPrevented) onKeyDown?.(event);
            if (event.defaultPrevented) return;
            // Enter sends and Shift+Enter breaks the line; Backspace on an empty draft drops an image.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              draft.submit();
            } else if (event.key === "Backspace" && !draft.value && attachments.items.length) {
              event.preventDefault();
              attachments.removeLast();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="relative justify-between px-2 pt-0 pb-2">
          <TypingEffect value={draft.value} />
          <div className="relative flex min-w-0 items-center gap-1">
            <ComposerAction label="Attach images" onClick={attachments.openPicker}>
              <Image className="h-4 w-4" />
            </ComposerAction>
            {controls}
          </div>
          <div className="relative flex items-center gap-0.5">{actions}</div>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

/** A toolbar icon button, named by its tooltip. */
export function ComposerAction({
  label,
  ...props
}: Omit<ComponentProps<typeof InputGroupButton>, "aria-label" | "size"> & { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InputGroupButton size="icon-xs" aria-label={label} suppressHydrationWarning {...props} />
        }
      />
      <TooltipContent sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The primary send action, available once the draft can be sent. */
export function ComposerSendButton({
  draft,
  label,
  className,
  children,
}: {
  draft: ComposerDraft;
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <ComposerAction
      type="submit"
      label={label}
      disabled={!draft.canSubmit}
      variant={draft.canSubmit ? "accent" : "ghost"}
      className={className}
    >
      {children ?? <ArrowUp className="h-4 w-4" />}
    </ComposerAction>
  );
}
