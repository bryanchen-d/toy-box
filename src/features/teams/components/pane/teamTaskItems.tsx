import { FileText } from "lucide-react";
import { AgentAvatar } from "@teams/components/agents/AgentAvatar";
import {
  teamAgentIdentity,
  teamTasksDiff,
  type TeamAgent,
  type TeamAgentIdentity,
  type TeamArtifact,
  type TeamTaskNode,
  type TeamTaskStatus,
} from "@teams/model";
import { isTeamTaskWorkingNow, type TeamAgentPresence } from "@teams/model/presence";
import type { DiffStats } from "@/shared/diffStats";
import { Button } from "@/shared/ui/button";
import type { ChecklistItem, ChecklistStatus } from "@/shared/ui/checklist";
import { PopoverClose } from "@/shared/ui/popover";
import { RunningIndicator } from "@/shared/ui/running-indicator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { TaskCard } from "./TaskCard";

const DIFF_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Each status's checklist mark; a completed task is the checklist's done. */
const CHECKLIST_STATUS: Record<TeamTaskStatus, ChecklistStatus> = {
  pending: "pending",
  in_progress: "in_progress",
  blocked: "blocked",
  in_review: "in_review",
  completed: "done",
  cancelled: "cancelled",
  deferred: "deferred",
  cut: "cut",
  duplicate: "duplicate",
};

/**
 * Both Team checklists present the same task identities, assignees, and linked outcomes, with each
 * task's record on hover. An assignee running a turn woken for its task shows as working on it.
 */
export function teamTaskItems({
  tasks,
  owners,
  artifacts,
  presence = {},
  onArtifactOpen,
  onTaskSelect,
  closeOnArtifactOpen = false,
}: {
  tasks: readonly TeamTaskNode[];
  owners: readonly TeamAgent[];
  artifacts: readonly TeamArtifact[];
  presence?: Readonly<Record<string, TeamAgentPresence>>;
  onArtifactOpen: (artifact: TeamArtifact) => void;
  /** Opens a task's view. */
  onTaskSelect?: (task: TeamTaskNode) => void;
  closeOnArtifactOpen?: boolean;
}): ChecklistItem[] {
  return tasks.map((task) => {
    const diff = task.status === "pending" ? undefined : teamTasksDiff([task]);
    const artifact = task.artifactId
      ? artifacts.find(({ id }) => id === task.artifactId)
      : undefined;
    const workingNow = isTeamTaskWorkingNow(task, presence);
    return {
      id: task.id,
      displayId: task.id,
      title: task.title,
      status: CHECKLIST_STATUS[task.status],
      card: <TaskCard task={task} owners={owners} artifacts={artifacts} workingNow={workingNow} />,
      detail:
        diff || task.assigneeId || task.artifactId ? (
          <span className="inline-flex items-center gap-[9px]">
            {diff && <TaskDiff diff={diff} />}
            {task.artifactId && (
              <TaskArtifact
                artifact={artifact}
                onOpen={onArtifactOpen}
                closeOnOpen={closeOnArtifactOpen}
              />
            )}
            {task.assigneeId && (
              <TaskOwner owner={teamAgentIdentity(owners, task.assigneeId)} working={workingNow} />
            )}
          </span>
        ) : undefined,
      ...(onTaskSelect && {
        select: {
          label: `Open ${task.id}: ${task.title}`,
          onSelect: () => onTaskSelect(task),
        },
      }),
      children:
        task.children.length > 0
          ? teamTaskItems({
              tasks: task.children,
              owners,
              artifacts,
              presence,
              onArtifactOpen,
              onTaskSelect,
              closeOnArtifactOpen,
            })
          : undefined,
    };
  });
}

export function TaskDiff({ diff }: { diff: DiffStats }) {
  const label = `${diff.added} lines added, ${diff.removed} lines removed`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex gap-[5px] font-mono text-2xs tabular-nums in-data-[slot=checklist-popup]:text-[10.5px]"
    >
      <span aria-hidden className="text-diff-added">
        +{DIFF_COUNT_FORMATTER.format(diff.added)}
      </span>
      <span aria-hidden className="text-diff-removed">
        {`\u2212${DIFF_COUNT_FORMATTER.format(diff.removed)}`}
      </span>
    </span>
  );
}

function TaskArtifact({
  artifact,
  onOpen,
  closeOnOpen,
}: {
  artifact?: TeamArtifact;
  onOpen: (artifact: TeamArtifact) => void;
  closeOnOpen: boolean;
}) {
  const label = artifact ? `Open ${artifact.title}` : "Artifact unavailable";
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="-m-1 text-muted-foreground"
      aria-label={label}
      title={artifact?.title ?? label}
      disabled={!artifact}
      onClick={artifact ? () => onOpen(artifact) : undefined}
    >
      <FileText aria-hidden className="size-3.5" />
    </Button>
  );
  return closeOnOpen ? <PopoverClose render={button} /> : button;
}

function TaskOwner({ owner, working }: { owner: TeamAgentIdentity; working: boolean }) {
  const label = working ? `${owner.name} · Working now` : owner.name;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span role="img" aria-label={label} className="relative inline-flex" />}
      >
        <AgentAvatar agent={owner} className="size-4 in-data-[slot=checklist-popup]:size-3.5" />
        {working && (
          <RunningIndicator
            strokeWidth={1.5}
            className="pointer-events-none absolute -top-1 -left-1 size-6 text-muted-foreground in-data-[slot=checklist-popup]:size-5.5"
          />
        )}
      </TooltipTrigger>
      <TooltipContent sideOffset={4}>{label}</TooltipContent>
    </Tooltip>
  );
}
