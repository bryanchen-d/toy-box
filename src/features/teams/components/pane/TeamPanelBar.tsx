import {
  Clock3,
  Files,
  Hash,
  ListChecks,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
  ShieldAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PaneVariant } from "@workspace/components/panes/shell/WorkspacePaneView";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";
import { TEAM_PANELS, type TeamPanel } from "./panels";

const PANEL_BUTTONS: Record<TeamPanel, { icon: LucideIcon; label: string }> = {
  overview: { icon: Hash, label: "Overview" },
  canvas: { icon: PanelsTopLeft, label: "Canvas" },
  members: { icon: Users, label: "Members" },
  tasks: { icon: ListChecks, label: "Tasks" },
  artifacts: { icon: Files, label: "Artifacts" },
  routines: { icon: Clock3, label: "Routines" },
  security: { icon: ShieldAlert, label: "Security" },
};

/** The Team pane's right edge: one toggle per panel, so each is a click from chat. */
export function TeamPanelBar({
  panel,
  asideOpen,
  hasCanvas,
  alerts,
  variant,
  onToggle,
  onToggleAside,
}: {
  panel: TeamPanel | undefined;
  asideOpen: boolean;
  hasCanvas: boolean;
  /** Panels holding something that needs the user, such as an unreviewed security finding. */
  alerts: ReadonlySet<TeamPanel>;
  variant: PaneVariant;
  onToggle: (panel: TeamPanel) => void;
  onToggleAside: () => void;
}) {
  const toggleLabel = asideOpen ? "Close panel" : "Open panel";

  return (
    <nav
      aria-label="Team panels"
      className={cn(
        "flex w-10 shrink-0 flex-col items-center gap-1 border-l bg-background pb-3",
        // A normal pane floats its actions over its top-right corner.
        variant === "normal" ? "pt-12" : "pt-2",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={toggleLabel}
              aria-expanded={asideOpen}
              className="text-muted-foreground hover:text-foreground"
              onClick={onToggleAside}
            >
              {asideOpen ? <PanelRightClose /> : <PanelRightOpen />}
            </Button>
          }
        />
        <TooltipContent side="left" sideOffset={6}>
          {toggleLabel}
        </TooltipContent>
      </Tooltip>
      {TEAM_PANELS.map((kind) => {
        const { icon: Icon, label } = PANEL_BUTTONS[kind];
        const isOpen = panel === kind;
        const unavailable = kind === "canvas" && !hasCanvas;
        const alert = alerts.has(kind);
        const tooltip = unavailable ? "No canvas yet" : alert ? `${label}: needs review` : label;

        return (
          <Tooltip key={kind}>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={alert ? `${label}, needs review` : label}
                  aria-pressed={isOpen}
                  aria-disabled={unavailable || undefined}
                  className={cn(
                    "relative",
                    isOpen ? "bg-muted text-foreground" : "text-muted-foreground",
                    unavailable ? "cursor-not-allowed opacity-40" : "hover:text-foreground",
                  )}
                  onClick={() => {
                    if (!unavailable) onToggle(kind);
                  }}
                >
                  <Icon />
                  {alert && (
                    <span
                      aria-hidden
                      className="absolute top-1 right-1 size-2 rounded-full bg-destructive ring-2 ring-background"
                    />
                  )}
                </Button>
              }
            />
            <TooltipContent side="left" sideOffset={6}>
              {tooltip}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
