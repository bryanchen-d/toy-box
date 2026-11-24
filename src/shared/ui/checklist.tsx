import { useState, type ReactNode } from "react";
import {
  ChevronRight,
  CircleArrowRight,
  CircleDot,
  CircleEqual,
  CircleMinus,
  CircleSlash,
  CircleX,
} from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { DoneIndicator } from "@/shared/ui/done-indicator";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/shared/ui/preview-card";
import { RunningIndicator } from "@/shared/ui/running-indicator";
import { cn } from "@/shared/utils";

export type ChecklistStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "in_review"
  | "done"
  | "cancelled"
  | "deferred"
  | "cut"
  | "duplicate";

const FINISHED: ReadonlySet<ChecklistStatus> = new Set([
  "done",
  "cancelled",
  "deferred",
  "cut",
  "duplicate",
]);

/** An item is finished once done or set aside, however it ended; progress counts them all. */
export function isChecklistItemFinished({ status }: Pick<ChecklistItem, "status">): boolean {
  return FINISHED.has(status);
}

export type ChecklistItem = {
  id: string;
  title: string;
  status: ChecklistStatus;
  /** An identifier readers cite, shown muted before the title, such as a task's ID. */
  displayId?: string;
  /** Supporting context beside the title's first line, such as ownership or outcomes. */
  detail?: ReactNode;
  /** The item's record, shown while hovering it. */
  card?: ReactNode;
  /** Choosing the row, such as to open where its work was discussed. */
  select?: { label: string; onSelect: () => void };
  children?: readonly ChecklistItem[];
};

/** Which items a checklist shows. A parent of a shown item stays as its context. */
export type ChecklistFilter = (item: ChecklistItem) => boolean;

/**
 * Work items and their progress. Inherits its font size; finished parents start collapsed. A filter
 * hides items without changing their parents' progress.
 */
export function Checklist({
  items,
  show,
  empty,
  className,
}: {
  items: readonly ChecklistItem[];
  show?: ChecklistFilter;
  /** What shows in place of a list the filter leaves empty. */
  empty?: ReactNode;
  className?: string;
}) {
  const shown = show ? items.filter((item) => isShown(item, show)) : items;
  if (shown.length === 0 && empty) return empty;
  return (
    <ul className={cn("space-y-2", className)}>
      {shown.map((item) => {
        const context = show !== undefined && !show(item);
        return (
          // Keyed by status and context, so a parent re-derives its expansion when either changes.
          <ChecklistRow
            key={`${item.id}:${item.status}${context ? ":context" : ""}`}
            item={item}
            show={show}
            context={context}
          />
        );
      })}
    </ul>
  );
}

function isShown(item: ChecklistItem, show: ChecklistFilter): boolean {
  return show(item) || (item.children ?? []).some((child) => isShown(child, show));
}

function ChecklistRow({
  item,
  show,
  context,
}: {
  item: ChecklistItem;
  show?: ChecklistFilter;
  /** Shown only because a subtask is, so it starts open to show them. */
  context: boolean;
}) {
  const children = item.children ?? [];
  const shownChildren = show ? children.filter((child) => isShown(child, show)) : children;
  const expandable = shownChildren.length > 0;
  const finished = isChecklistItemFinished(item);
  const [expanded, setExpanded] = useState(!finished || context);
  const finishedCount = children.filter(isChecklistItemFinished).length;
  const lastSpace = item.title.lastIndexOf(" ");
  const titleClassName = cn(
    "wrap-anywhere",
    finished && "text-muted-foreground",
    item.select && "group-hover/checklist-row:underline",
  );

  const row = (
    <div
      role="presentation"
      className={cn(
        "group/checklist-row relative flex min-w-0 items-start gap-2 leading-snug",
        (expandable || item.select) && "cursor-pointer",
      )}
      onClick={(event) => {
        if (
          expandable &&
          event.target instanceof Element &&
          !event.target.closest("button, a, input, select, textarea, [role=button], [role=link]")
        ) {
          setExpanded((current) => !current);
        }
      }}
    >
      {item.select && (
        // Covers the row, beneath its own controls, so the whole row chooses the item.
        <button
          type="button"
          aria-label={item.select.label}
          // A hover card already describes the item, so the native tooltip would only cover it.
          title={item.card ? undefined : item.select.label}
          className="absolute -inset-x-1 -inset-y-0.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={item.select.onSelect}
        />
      )}
      <span className="flex h-lh w-4 shrink-0 items-center justify-center *:shrink-0">
        {MARKS[item.status]}
      </span>
      <div className="flow-root min-w-0 flex-1">
        {item.detail && (
          <span className="relative float-right ms-2.5 flex h-lh items-center">{item.detail}</span>
        )}
        {item.displayId && (
          <span className="me-1.5 text-muted-foreground tabular-nums">{item.displayId}</span>
        )}
        {children.length > 0 ? (
          <span className={titleClassName}>
            {item.title.slice(0, lastSpace + 1)}
            <span className="whitespace-nowrap">
              {item.title.slice(lastSpace + 1)}
              {!finished && (
                <Badge
                  variant="count"
                  className="ms-1.5 align-middle"
                  aria-label={`${finishedCount} of ${children.length} subtasks finished`}
                >
                  {finishedCount}/{children.length}
                </Badge>
              )}
              {expandable && (
                <button
                  type="button"
                  className="relative ms-0.5 inline-flex size-[1.15em] items-center justify-center rounded-sm align-[-0.2em] text-muted-foreground outline-none group-hover/checklist-row:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Subtasks of ${item.title}`}
                  aria-expanded={expanded}
                  onClick={() => setExpanded((current) => !current)}
                >
                  <ChevronRight
                    aria-hidden
                    className={cn("size-3 transition-transform", expanded && "rotate-90")}
                  />
                </button>
              )}
            </span>
          </span>
        ) : (
          <span className={titleClassName}>{item.title}</span>
        )}
      </div>
    </div>
  );

  return (
    <li className="space-y-2">
      {item.card ? (
        <PreviewCard>
          <PreviewCardTrigger render={row} />
          <PreviewCardContent side="left" align="start" className="w-80">
            {item.card}
          </PreviewCardContent>
        </PreviewCard>
      ) : (
        row
      )}
      {expanded && expandable && (
        <Checklist items={children} show={show} className="ml-2 border-l pl-4" />
      )}
    </li>
  );
}

// Indicators draw at r=9, inside Lucide's stroked r=10 circle, so they're sized up to match its edge.
// Items set aside without being done keep a muted mark of their own.
const MARKS: Record<ChecklistStatus, ReactNode> = {
  // The in-progress track without its arc, so starting work only adds the arc.
  pending: (
    <svg
      role="img"
      aria-label="Pending"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className="size-4.5 text-muted-foreground"
    >
      <circle cx={12} cy={12} r={9} opacity={0.25} />
    </svg>
  ),
  in_progress: (
    <RunningIndicator
      role="img"
      aria-label="In progress"
      className="size-4.5 text-muted-foreground"
    />
  ),
  blocked: <CircleSlash role="img" aria-label="Blocked" className="size-4 text-destructive" />,
  in_review: (
    <CircleDot
      role="img"
      aria-label="In review"
      className="size-4 text-amber-600 dark:text-amber-400"
    />
  ),
  done: <DoneIndicator role="img" aria-label="Done" className="size-5.5" />,
  cancelled: <CircleX role="img" aria-label="Cancelled" className="size-4 text-muted-foreground" />,
  deferred: (
    <CircleArrowRight role="img" aria-label="Deferred" className="size-4 text-muted-foreground" />
  ),
  cut: <CircleMinus role="img" aria-label="Cut" className="size-4 text-muted-foreground" />,
  duplicate: (
    <CircleEqual role="img" aria-label="Duplicate" className="size-4 text-muted-foreground" />
  ),
};
