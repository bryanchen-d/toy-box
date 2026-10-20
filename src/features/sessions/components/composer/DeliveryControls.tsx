// Where a session draft goes. Inbox runs new work by default; a session receives the message,
// and while a turn runs it queues by default or can be sent immediately.

import type { ReactNode } from "react";
import { formatForDisplay } from "@tanstack/react-hotkeys";
import { ArrowUp, ChevronDown, Play } from "lucide-react";
import { ComposerSendButton } from "@/shared/composers/Composer";
import type { ComposerDraft } from "@/shared/composers/useComposerDraft";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { InputGroupButton } from "@/shared/ui/input-group";

/** Sends a queued follow-up immediately instead. */
export const sendNowHotkey = "Mod+Enter";

/** Runs the draft as Inbox work, or sends it as an ordinary session. */
export function RunControls({ draft, onSend }: { draft: ComposerDraft; onSend: () => void }) {
  return (
    <div className="flex items-center rounded-[calc(var(--radius)-5px)]">
      <ComposerSendButton draft={draft} label="Run" className="rounded-e-none">
        <Play className="h-4 w-4" />
      </ComposerSendButton>
      <DeliveryOptions label="Run options" disabled={!draft.canSubmit}>
        <DropdownMenuItem onClick={() => draft.submit()}>
          <Play />
          <div className="flex flex-col">
            <span>Run</span>
            <span className="text-xs text-muted-foreground">Sends the result to Inbox</span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSend}>
          <ArrowUp />
          <div className="flex flex-col">
            <span>Send</span>
            <span className="text-xs text-muted-foreground">Adds the session to your list</span>
          </div>
        </DropdownMenuItem>
      </DeliveryOptions>
    </div>
  );
}

/** Sends the draft to its session; while a turn runs, queues it unless sent now. */
export function SendControls({
  draft,
  isBusy,
  onSendNow,
}: {
  draft: ComposerDraft;
  isBusy: boolean;
  onSendNow: () => void;
}) {
  return (
    <div className="flex">
      <ComposerSendButton
        draft={draft}
        label={isBusy ? "Queue message" : "Send message"}
        className={isBusy ? "rounded-e-none" : undefined}
      />
      {isBusy && (
        <DeliveryOptions label="Message delivery options" disabled={!draft.canSubmit}>
          <DropdownMenuItem onClick={() => draft.submit()}>
            <ArrowUp />
            Queue message
            <DropdownMenuShortcut>{formatForDisplay("Enter")}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onSendNow}>
            <Play />
            Send immediately
            <DropdownMenuShortcut>{formatForDisplay(sendNowHotkey)}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DeliveryOptions>
      )}
    </div>
  );
}

/** The split-button menu beside a send action; submission keeps focus in the input. */
function DeliveryOptions({
  label,
  disabled,
  children,
}: {
  label: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            variant={disabled ? "ghost" : "accent"}
            suppressHydrationWarning
            className="w-4 rounded-s-none border-l border-background data-[popup-open]:bg-accent/90"
          />
        }
      >
        <ChevronDown className="h-3 w-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" finalFocus={false}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
