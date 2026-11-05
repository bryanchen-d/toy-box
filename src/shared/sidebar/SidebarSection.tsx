import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { SidebarStatus } from "./SidebarStatus";
import { cn } from "@/shared/utils";

export type SidebarSectionProps = {
  title: string;
  /** How many items the section holds, shown beside its title when there are any. */
  count?: number;
  isExpanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  action?: ReactNode;
  /** What its items are doing; while collapsed, the most pressing replaces the action. */
  activity?: { waiting?: boolean; finished?: boolean; unread?: boolean; running?: boolean };
  /** Whether the expanded section takes the sidebar's remaining height rather than its content's. */
  fill?: boolean;
  children: ReactNode;
};

/** One collapsible sidebar section: a titled header row over a body that folds away. */
export function SidebarSection({
  title,
  count = 0,
  isExpanded,
  onExpandedChange,
  action,
  activity,
  fill = false,
  children,
}: SidebarSectionProps) {
  const status = isExpanded ? undefined : SECTION_STATUSES.find(({ kind }) => activity?.[kind]);

  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden border-t first:border-t-0",
        // The filling section alone yields height when the sidebar is short, so
        // the sections above and below it keep their content's height.
        fill
          ? cn(
              "min-h-0 transition-[flex-grow] duration-200 ease-out motion-reduce:transition-none",
              isExpanded ? "grow" : "grow-0",
            )
          : "shrink-0",
      )}
    >
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 bg-background px-3 py-2",
          isExpanded && "border-b border-border",
        )}
      >
        <button
          type="button"
          aria-label={`${isExpanded ? "Collapse" : "Expand"} ${title.toLowerCase()}`}
          aria-expanded={isExpanded}
          onClick={() => onExpandedChange(!isExpanded)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
              isExpanded && "rotate-90",
            )}
          />
          <span className="section-heading">{title}</span>
          {count > 0 && <Badge variant="count">{count}</Badge>}
        </button>

        {status ? (
          <SidebarStatus
            status={{ ...status, ariaLabel: `${title}: ${status.tooltip.toLowerCase()}` }}
            className="size-6"
          />
        ) : (
          action
        )}
      </div>

      <div
        aria-hidden={!isExpanded}
        inert={!isExpanded}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          fill && "min-h-0 flex-1",
          isExpanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              "transition-transform duration-200 ease-out motion-reduce:transition-none",
              fill && "flex h-full flex-col",
              isExpanded ? "translate-y-0" : "-translate-y-1 pointer-events-none",
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Most pressing first, with completion taking precedence over ordinary unread messages. */
const SECTION_STATUSES = [
  { kind: "waiting", tooltip: "Waiting for input" },
  { kind: "finished", tooltip: "Done" },
  { kind: "unread", tooltip: "Unread messages" },
  { kind: "running", tooltip: "Running" },
] as const;
