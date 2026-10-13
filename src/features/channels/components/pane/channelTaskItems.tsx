import { FileText } from "lucide-react";
import { AgentAvatar } from "@channels/components/agents/AgentAvatar";
import {
  channelAgentIdentity,
  channelTasksDiff,
  type ChannelAgent,
  type ChannelAgentIdentity,
  type ChannelArtifact,
  type ChannelTask,
} from "@channels/model";
import type { DiffStats } from "@/shared/diffStats";
import { Button } from "@/shared/ui/button";
import type { ChecklistItem } from "@/shared/ui/checklist";
import { PopoverClose } from "@/shared/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

const DIFF_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Both Channel checklists present the same task identities, owners, and linked outcomes. */
export function channelTaskItems({
  tasks,
  owners,
  artifacts,
  onArtifactOpen,
  closeOnArtifactOpen = false,
}: {
  tasks: readonly ChannelTask[];
  owners: readonly ChannelAgent[];
  artifacts: readonly ChannelArtifact[];
  onArtifactOpen: (artifact: ChannelArtifact) => void;
  closeOnArtifactOpen?: boolean;
}): ChecklistItem[] {
  return tasks.map((task) => {
    const diff = task.status === "pending" ? undefined : channelTasksDiff([task]);
    const artifact = task.artifactId
      ? artifacts.find(({ id }) => id === task.artifactId)
      : undefined;
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      detail:
        diff || task.ownerId || task.artifactId ? (
          <span className="inline-flex items-center gap-[9px]">
            {diff && <TaskDiff diff={diff} />}
            {task.artifactId && (
              <TaskArtifact
                artifact={artifact}
                onOpen={onArtifactOpen}
                closeOnOpen={closeOnArtifactOpen}
              />
            )}
            {task.ownerId && <TaskOwner owner={channelAgentIdentity(owners, task.ownerId)} />}
          </span>
        ) : undefined,
      children:
        task.children &&
        channelTaskItems({
          tasks: task.children,
          owners,
          artifacts,
          onArtifactOpen,
          closeOnArtifactOpen,
        }),
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
  artifact?: ChannelArtifact;
  onOpen: (artifact: ChannelArtifact) => void;
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

function TaskOwner({ owner }: { owner: ChannelAgentIdentity }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span role="img" aria-label={owner.name} className="inline-flex" />}>
        <AgentAvatar agent={owner} className="size-4 in-data-[slot=checklist-popup]:size-3.5" />
      </TooltipTrigger>
      <TooltipContent sideOffset={4}>{owner.name}</TooltipContent>
    </Tooltip>
  );
}
