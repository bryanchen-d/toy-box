import { useRef, useState, type ReactNode } from "react";
import { Clock3 } from "lucide-react";
import { AgentAvatar } from "@teams/components/agents/AgentAvatar";
import {
  teamTasksDiff,
  type Team,
  type TeamArtifact,
  type TeamRoutine,
  type TeamTask,
} from "@teams/model";
import { ArtifactPill } from "@workspace/components/outputs/ArtifactPill";
import { SessionMetadataBadges } from "@sessions/components/location/SessionMetadataBadges";
import { Badge } from "@/shared/ui/badge";
import { ProgressBar } from "@/shared/ui/progress-bar";
import { SectionHeading } from "@/shared/ui/section-heading";
import { RelativeTime } from "@/shared/ui/relative-time";
import { ShowMore, useShowMore } from "@/shared/ui/show-more";
import { nextCronOccurrence } from "@/shared/cron";
import { cn } from "@/shared/utils";
import { useTeamPane } from "../TeamPaneContext";
import type { TeamPanel } from "../panels";
import { TaskDiff } from "../teamTaskItems";
import { WorkspacePreview } from "@workspace/components/outputs/WorkspacePreview";

const SUMMARY_LIMIT = 3;

/** What the overview shows: the Team's context, then a summary of each panel that opens it. */
export function TeamOverviewContent({
  team,
  artifacts,
  routines,
  onBrowseDirectory,
}: {
  team: Team;
  artifacts: TeamArtifact[];
  routines: TeamRoutine[];
  onBrowseDirectory: () => void;
}) {
  const { lead, members, presence, openArtifact, openPanel } = useTeamPane();
  const agents = [lead, ...[...members].sort((left, right) => left.name.localeCompare(right.name))];
  const workingCount = agents.filter(({ id }) => presence[id]?.state === "working").length;
  const completedCount = team.tasks.filter(({ status }) => status === "done").length;
  const inProgress = allTasks(team.tasks).filter(({ status }) => status === "in_progress");
  const diff = teamTasksDiff(team.tasks);
  const sharedArtifacts = artifacts.filter(({ archived }) => !archived);
  const [now] = useState(() => new Date());
  const nextRoutine = routines
    .map((routine) => ({ routine, at: nextCronOccurrence(routine.schedule, now) }))
    .sort((left, right) => left.at.getTime() - right.at.getTime())[0];

  return (
    <div className="min-h-0 flex-1 space-y-6 overflow-y-auto bg-panel p-4">
      <div className="space-y-3">
        {team.purpose ? (
          <TeamPurpose purpose={team.purpose} />
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground italic">
            No purpose defined yet.
          </p>
        )}
        {team.directory && (
          <button
            type="button"
            aria-label={`Browse ${team.directory}`}
            className="flex max-w-full rounded-full outline-none transition-opacity hover:opacity-75 focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onBrowseDirectory}
          >
            <SessionMetadataBadges cwd={team.directory} />
          </button>
        )}
        {team.preview && <WorkspacePreview preview={team.preview} variant="row" />}
      </div>

      <OverviewSection
        title="Team members"
        count={agents.length}
        panel="members"
        onOpenPanel={openPanel}
      >
        <div className="flex items-center gap-3">
          <div className="flex -space-x-1.5">
            {agents.map((agent) => (
              <span key={agent.id} title={agent.name} className="rounded-full ring-2 ring-panel">
                <AgentAvatar agent={agent} className="size-7" />
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {workingCount > 0 ? `${workingCount} working` : "All idle"}
          </p>
        </div>
      </OverviewSection>

      <OverviewSection
        title="Task list"
        count={`${completedCount}/${team.tasks.length}`}
        detail={diff && <TaskDiff diff={diff} />}
        panel="tasks"
        onOpenPanel={openPanel}
      >
        {team.tasks.length > 0 ? (
          <div className="space-y-2">
            <ProgressBar value={completedCount / team.tasks.length} className="block w-full" />
            {inProgress.length > 0 ? (
              <ul className="space-y-1 text-sm text-foreground/90">
                {inProgress.slice(0, SUMMARY_LIMIT).map((task) => (
                  <li key={task.id} className="truncate">
                    {task.title}
                  </li>
                ))}
                {inProgress.length > SUMMARY_LIMIT && (
                  <li className="text-xs text-muted-foreground">
                    +{inProgress.length - SUMMARY_LIMIT} more in progress
                  </li>
                )}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing in progress.</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No tasks yet.</p>
        )}
      </OverviewSection>

      <OverviewSection
        title="Artifacts"
        count={sharedArtifacts.length}
        panel="artifacts"
        onOpenPanel={openPanel}
      >
        {sharedArtifacts.length > 0 ? (
          <div role="list" aria-label={`Artifacts in #${team.name}`} className="flex flex-col">
            {sharedArtifacts.slice(0, SUMMARY_LIMIT).map((artifact) => (
              <ArtifactPill
                key={artifact.id}
                file={artifact.file}
                label={artifact.title}
                pinned={artifact.pinned}
                detail={<RelativeTime className="text-muted-foreground" date={artifact.sharedAt} />}
                className="w-full text-foreground"
                onClick={() => openArtifact(artifact.file)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {artifacts.length > 0 ? "Every artifact is archived." : "No artifacts shared yet."}
          </p>
        )}
      </OverviewSection>

      <OverviewSection
        title="Routines"
        count={routines.length}
        panel="routines"
        onOpenPanel={openPanel}
      >
        {nextRoutine ? (
          <div className="flex min-w-0 flex-col items-start gap-1 text-sm">
            <span className="truncate text-foreground/90">{nextRoutine.routine.title}</span>
            <Badge variant="metadata" title={nextRoutine.routine.schedule}>
              <Clock3 className="h-3 w-3 shrink-0" />
              {team.paused ? "Paused" : <RelativeTime date={nextRoutine.at} />}
            </Badge>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No routines scheduled yet.</p>
        )}
      </OverviewSection>
    </div>
  );
}

function allTasks(tasks: readonly TeamTask[]): TeamTask[] {
  return tasks.flatMap((task) => [task, ...allTasks(task.children ?? [])]);
}

/** The purpose, clamped to three lines until the reader expands it. */
function TeamPurpose({ purpose }: { purpose: string }) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const { collapsed, toggle } = useShowMore(textRef, purpose);

  return (
    <div>
      <p
        ref={textRef}
        className={cn(
          "whitespace-pre-wrap text-sm leading-relaxed text-foreground/90",
          collapsed && "line-clamp-3",
        )}
      >
        {purpose}
      </p>
      {toggle && <ShowMore {...toggle} />}
    </div>
  );
}

/** One panel's summary, headed by a link to the whole panel. */
function OverviewSection({
  title,
  count,
  detail,
  panel,
  onOpenPanel,
  children,
}: {
  title: string;
  count: number | string;
  detail?: ReactNode;
  panel: TeamPanel;
  onOpenPanel: (panel: TeamPanel) => void;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 not-first-of-type:border-t not-first-of-type:pt-6">
      <SectionHeading
        title={title}
        count={count}
        detail={
          <div className="flex items-center gap-2">
            {detail}
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onOpenPanel(panel)}
            >
              View all
            </button>
          </div>
        }
      />
      {children}
    </section>
  );
}
