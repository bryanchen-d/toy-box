import { AgentAvatar } from "@teams/components/agents/AgentAvatar";
import {
  isTeamTaskOpen,
  teamAgentIdentity,
  teamTasksDiff,
  type TeamAgent,
  type TeamArtifact,
  type TeamTaskNode,
  type TeamTaskStatus,
} from "@teams/model";
import { Badge } from "@/shared/ui/badge";
import { Markdown } from "@/shared/ui/markdown";
import { RelativeTime } from "@/shared/ui/relative-time";
import { RunningIndicator } from "@/shared/ui/running-indicator";

const STATUS_LABELS: Record<TeamTaskStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "Blocked",
  in_review: "In review",
  completed: "Completed",
  cancelled: "Cancelled",
  deferred: "Deferred",
  cut: "Cut",
  duplicate: "Duplicate",
};

/** Where a task stands, saying how it closed once it has, such as "Closed as deferred". */
export function teamTaskStatusLabel(status: TeamTaskStatus): string {
  return isTeamTaskOpen({ status })
    ? STATUS_LABELS[status]
    : `Closed as ${STATUS_LABELS[status].toLowerCase()}`;
}

/**
 * A task's record: where it stands, what it asks for, who has it, whether they're working on it
 * now, and what it produced.
 */
export function TaskCard({
  task,
  owners,
  artifacts,
  workingNow = false,
}: {
  task: TeamTaskNode;
  owners: readonly TeamAgent[];
  artifacts: readonly TeamArtifact[];
  /** Its assignee is running a turn woken for it. */
  workingNow?: boolean;
}) {
  const assignee = task.assigneeId ? teamAgentIdentity(owners, task.assigneeId) : undefined;
  const artifact = task.artifactId ? artifacts.find(({ id }) => id === task.artifactId) : undefined;
  const diff = teamTasksDiff([task]);
  const closedCount = task.children.filter((child) => !isTeamTaskOpen(child)).length;

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        <span className="font-medium text-foreground tabular-nums">{task.id}</span>
        <span>{teamTaskStatusLabel(task.status)}</span>
        {task.priority !== "normal" && (
          <Badge variant="metadata">
            {task.priority === "high" ? "High priority" : "Low priority"}
          </Badge>
        )}
      </div>
      <p className="text-sm font-medium wrap-anywhere">{task.title}</p>
      {task.description && (
        <div className="max-h-48 overflow-hidden text-muted-foreground">
          <Markdown className="space-y-1.5 text-xs [&_h2]:text-xs [&_h2]:font-semibold [&_h3]:text-xs">
            {task.description}
          </Markdown>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Assignee</dt>
        <dd className="flex min-w-0 items-center gap-1.5">
          {assignee ? (
            <>
              <AgentAvatar agent={assignee} className="size-4" />
              <span className="truncate">{assignee.name}</span>
              {workingNow && (
                <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                  <RunningIndicator aria-hidden className="size-3.5" />
                  Working now
                </span>
              )}
            </>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
        </dd>
        {task.artifactId && (
          <>
            <dt className="text-muted-foreground">Artifact</dt>
            <dd className="truncate">{artifact?.title ?? "Unavailable"}</dd>
          </>
        )}
        {diff && (
          <>
            <dt className="text-muted-foreground">Diff</dt>
            <dd className="tabular-nums">
              <span className="text-diff-added">+{diff.added}</span>{" "}
              <span className="text-diff-removed">{`\u2212${diff.removed}`}</span> lines
            </dd>
          </>
        )}
        {task.children.length > 0 && (
          <>
            <dt className="text-muted-foreground">Subtasks</dt>
            <dd>
              {closedCount} of {task.children.length} closed
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">Changed</dt>
        <dd>
          <RelativeTime date={task.updatedAt} /> by{" "}
          {task.updatedBy.type === "agent"
            ? teamAgentIdentity(owners, task.updatedBy.agentId).name
            : "you"}
        </dd>
      </dl>
    </div>
  );
}
