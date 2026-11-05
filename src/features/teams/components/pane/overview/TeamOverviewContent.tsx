import { useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Clock3, Pencil, Play, Plus, Trash2, UserMinus } from "lucide-react";
import { AgentItem } from "@teams/components/agents/AgentItem";
import {
  teamTasksDiff,
  type Team,
  type TeamArtifact,
  type TeamMember,
  type TeamRoutine,
} from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { ArtifactPill } from "@workspace/components/outputs/ArtifactPill";
import { SessionMetadataBadges } from "@sessions/components/location/SessionMetadataBadges";
import { Badge } from "@/shared/ui/badge";
import { Checklist } from "@/shared/ui/checklist";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/shared/ui/dropdown-menu";
import { SectionHeading } from "@/shared/ui/section-heading";
import { RelativeTime } from "@/shared/ui/relative-time";
import { ShowMore, useShowMore } from "@/shared/ui/show-more";
import { nextCronOccurrence } from "@/shared/cron";
import { cn } from "@/shared/utils";
import { useTeamPane } from "../TeamPaneContext";
import { teamTaskItems, TaskDiff } from "../teamTaskItems";
import { WorkspacePreview } from "@workspace/components/outputs/WorkspacePreview";
import { RowMenu } from "./RowMenu";
import { CopyTeamUri } from "@teams/components/CopyTeamUri";

/** What the overview shows: the Team's context, team members, tasks, artifacts, and routines. */
export function TeamOverviewContent({
  team,
  artifacts,
  routines,
  onArtifactOpen,
  onManageArtifacts,
  onViewMembers,
  onEditMember,
  onRemoveMember,
  onAddAgent,
  onBrowseDirectory,
  onPreviewOpen,
}: {
  team: Team;
  artifacts: TeamArtifact[];
  routines: TeamRoutine[];
  onArtifactOpen: (artifact: TeamArtifact) => void;
  onManageArtifacts: () => void;
  onViewMembers: () => void;
  onEditMember: (member: TeamMember) => void;
  onRemoveMember: (member: TeamMember) => void;
  onAddAgent: () => void;
  onBrowseDirectory: () => void;
  onPreviewOpen: () => void;
}) {
  const { lead, members, agents } = useTeamPane();
  const sortedMembers = [...members].sort((left, right) => left.name.localeCompare(right.name));
  const completedCount = team.tasks.filter(({ status }) => status === "done").length;
  const diff = teamTasksDiff(team.tasks);
  const sharedArtifacts = artifacts.filter(({ archived }) => !archived);

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
        {team.preview && (
          <WorkspacePreview preview={team.preview} variant="row" onOpen={onPreviewOpen} />
        )}
      </div>

      <OverviewSection
        title="Team members"
        count={members.length + 1}
        detail={
          <div className="flex items-center gap-1">
            <RowMenu name="Members">
              <CopyTeamUri target={{ type: "members", teamId: team.id }} label="Copy members URI" />
            </RowMenu>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={onViewMembers}
            >
              View all
            </button>
          </div>
        }
      >
        <div>
          <div role="list" aria-label={`Team members in #${team.name}`}>
            <AgentItem
              agent={lead}
              action={
                <RowMenu name={lead.name}>
                  <CopyTeamUri
                    target={{ type: "agent", teamId: team.id, agentId: lead.id }}
                    label="Copy agent URI"
                  />
                </RowMenu>
              }
            />
            {sortedMembers.map((member) => (
              <AgentItem
                key={member.id}
                agent={member}
                action={
                  <RowMenu name={member.name}>
                    <CopyTeamUri
                      target={{ type: "agent", teamId: team.id, agentId: member.id }}
                      label="Copy agent URI"
                    />
                    <DropdownMenuItem onClick={() => onEditMember(member)}>
                      <Pencil /> Edit member
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onClick={() => onRemoveMember(member)}>
                      <UserMinus /> Remove from team
                    </DropdownMenuItem>
                  </RowMenu>
                }
              />
            ))}
          </div>
          <button
            type="button"
            disabled={team.paused}
            className="flex w-full items-center gap-2.5 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
            onClick={onAddAgent}
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed border-current/40">
              <Plus className="size-3" />
            </span>
            Add an agent
          </button>
        </div>
      </OverviewSection>

      <OverviewSection
        title="Task list"
        count={`${completedCount}/${team.tasks.length}`}
        detail={diff && <TaskDiff diff={diff} />}
      >
        {team.tasks.length > 0 ? (
          <Checklist
            items={teamTaskItems({
              tasks: team.tasks,
              owners: agents,
              artifacts,
              onArtifactOpen,
            })}
            className="text-sm"
          />
        ) : (
          <p className="text-sm text-muted-foreground italic">No tasks yet.</p>
        )}
      </OverviewSection>

      <OverviewSection
        title="Artifacts"
        count={sharedArtifacts.length}
        detail={
          artifacts.length > 0 && (
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={onManageArtifacts}
            >
              Manage
            </button>
          )
        }
      >
        {sharedArtifacts.length > 0 ? (
          <div role="list" aria-label={`Artifacts in #${team.name}`} className="flex flex-col">
            {sharedArtifacts.map((artifact) => (
              <ArtifactPill
                key={artifact.id}
                file={artifact.file}
                label={artifact.title}
                pinned={artifact.pinned}
                detail={<RelativeTime className="text-muted-foreground" date={artifact.sharedAt} />}
                className="w-full text-foreground"
                onClick={() => onArtifactOpen(artifact)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {artifacts.length > 0 ? "Every artifact is archived." : "No artifacts shared yet."}
          </p>
        )}
      </OverviewSection>

      <OverviewSection title="Routines" count={routines.length}>
        {routines.length > 0 ? (
          <div role="list" aria-label={`Routines in #${team.name}`} className="space-y-2">
            {routines.map((routine) => (
              <RoutineItem
                key={routine.id}
                teamId={team.id}
                paused={team.paused}
                routine={routine}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No routines scheduled yet.</p>
        )}
      </OverviewSection>
    </div>
  );
}

/** A routine's title and next run, expanding to its prompt. Only the lead adds or changes one;
 *  you can run or delete it. */
function RoutineItem({
  teamId,
  paused,
  routine,
}: {
  teamId: string;
  paused: boolean;
  routine: TeamRoutine;
}) {
  const { mutate: runRoutine, error: runError } = useMutation(teamMutations.runRoutine(teamId));
  const { mutate: deleteRoutine } = useMutation(teamMutations.deleteRoutine(teamId));
  const [now] = useState(() => new Date());

  return (
    <div role="listitem" className="flex items-start gap-2 text-sm">
      <details className="group min-w-0 flex-1">
        <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
          <span className="flex min-w-0 flex-col items-start gap-1">
            <span className="text-foreground/90">{routine.title}</span>
            <Badge variant="metadata" title={routine.schedule}>
              <Clock3 className="h-3 w-3 shrink-0" />
              {paused ? (
                "Paused"
              ) : (
                <RelativeTime date={nextCronOccurrence(routine.schedule, now)} />
              )}
            </Badge>
          </span>
        </summary>
        <p className="mt-1.5 ml-5.5 whitespace-pre-wrap text-xs text-muted-foreground">
          {routine.prompt}
        </p>
        {runError && (
          <p role="alert" className="text-xs text-destructive">
            {runError.message}
          </p>
        )}
      </details>
      <RowMenu name={routine.title}>
        <DropdownMenuItem disabled={paused} onClick={() => runRoutine(routine.id)}>
          <Play /> Run routine
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => deleteRoutine(routine.id)}>
          <Trash2 /> Delete routine
        </DropdownMenuItem>
      </RowMenu>
    </div>
  );
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

function OverviewSection({
  title,
  count,
  detail,
  children,
}: {
  title: string;
  count: number | string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 not-first-of-type:border-t not-first-of-type:pt-6">
      <SectionHeading title={title} count={count} detail={detail} />
      {children}
    </section>
  );
}
