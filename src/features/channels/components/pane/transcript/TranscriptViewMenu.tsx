import { MessagesSquare, UserRound, type LucideIcon } from "lucide-react";
import type { PaneVariant } from "@workspace/components/panes/shell/WorkspacePaneView";
import {
  PANE_OVERLAY_BUTTON_CLASS,
  PANE_OVERLAY_ICON_CLASS,
} from "@workspace/components/panes/shell/paneControls";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import type { TranscriptView } from "./transcriptRows";

const VIEWS = [
  { value: "all", label: "All messages", Icon: MessagesSquare },
  { value: "yours", label: "Your messages", Icon: UserRound },
] satisfies { value: TranscriptView; label: string; Icon: LucideIcon }[];

/** Chooses which messages the transcript shows; the trigger shows the current view's icon. */
export function TranscriptViewMenu({
  view,
  onViewChange,
  variant,
}: {
  view: TranscriptView;
  onViewChange: (view: TranscriptView) => void;
  variant: PaneVariant;
}) {
  const { label, Icon } = VIEWS.find(({ value }) => value === view)!;
  const triggerLabel = `Showing ${label.toLowerCase()}`;
  const isNormal = variant === "normal";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          isNormal ? (
            <button
              type="button"
              aria-label={triggerLabel}
              title={triggerLabel}
              className={PANE_OVERLAY_BUTTON_CLASS}
            />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={triggerLabel}
              title={triggerLabel}
            />
          )
        }
      >
        <Icon className={isNormal ? PANE_OVERLAY_ICON_CLASS : undefined} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" finalFocus={false}>
        <DropdownMenuRadioGroup value={view} onValueChange={onViewChange}>
          {VIEWS.map(({ value, label, Icon: OptionIcon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2 text-xs">
              <OptionIcon className="size-3.5 text-muted-foreground" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
