import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pencil, UserPlus, Users } from "lucide-react";
import { AgentEditor } from "@teams/components/agents/AgentEditor";
import { AgentItem } from "@teams/components/agents/AgentItem";
import { TeamDialog } from "@teams/components/TeamDialog";
import { teamTasksForAgent, compareTeamAgents, type Team, type TeamTask } from "@teams/model";
import { formatModelConfiguration } from "@providers/model";
import { teamQueries } from "@teams/queries";
import { sumSessionUsage, type SessionUsage } from "@sessions/model/usage";
import { selectSessionChildren, sessionQueries } from "@sessions/queries";
import { SubSessionList } from "@workers/components/SubSessions";
import { Button } from "@/shared/ui/button";
import { ClockTime } from "@/shared/ui/clock-time";
import { TruncatedText } from "@/shared/ui/truncated-text";
import { useTeamPane } from "./TeamPaneContext";
import { TeamPanelHeader } from "./TeamPanelHeader";
import { teamUri } from "@teams/model/references";
import { CopyUri } from "@/shared/ui/copy-uri";
import { RowMenu } from "./overview/RowMenu";
import { DropdownMenuCheckboxItem } from "@/shared/ui/dropdown-menu";

/** The dialog open over the roster: the Team's, which also configures its lead, one member's, or a
 *  new member's. */
type MembersDialog =
  | { type: "team" }
  | { type: "member"; agentId: string }
  | { type: "new_member" };

export function TeamMembers({
  team,
  tasks,
  isVisible = true,
  selectedAgentId,
}: {
  team: Team;
  tasks: readonly TeamTask[];
  isVisible?: boolean;
  selectedAgentId?: string;
}) {
  const { lead, members, presence } = useTeamPane();
  const [dialog, setDialog] = useState<MembersDialog>();
  const [showModel, setShowModel] = useState(false);
  const [showCredits, setShowCredits] = useState(false);
  const editingMember =
    dialog?.type === "member" ? members.find(({ id }) => id === dialog.agentId) : undefined;
  const closeDialog = () => setDialog(undefined);
  const agents = [lead, ...[...members].sort(compareTeamAgents)];
  const usage = useQuery({
    ...teamQueries.usage(team.id),
    enabled: isVisible && showCredits,
  });
  const total = sumSessionUsage(agents.map((agent) => usage.data?.[agent.id]));
  const { data: subSessionsByOwner } = useQuery({
    ...sessionQueries.state(),
    select: selectSessionChildren,
  });
  const selectedRef = useRef<HTMLTableRowElement>(null);
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, [selectedAgentId]);
  // The fixed layout shares the panel's width evenly among the four text columns, whose lines
  // truncate rather than widen the table. The minimum keeps each at least 10rem beside the
  // fixed-width columns shown: Agent (10rem), State (5rem), Model (12rem), and AI credits (8rem).
  const minWidth = `${55 + (showModel ? 12 : 0) + (showCredits ? 8 : 0)}rem`;

  return (
    <section
      aria-label={`Team members in #${team.name}`}
      className="flex h-full min-h-0 min-w-0 flex-col bg-panel"
    >
      <TeamPanelHeader icon={Users} title={`Team members (${agents.length})`}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Add an agent"
          title="Add an agent"
          disabled={team.paused}
          onClick={() => setDialog({ type: "new_member" })}
        >
          <UserPlus />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Edit team"
          title="Edit team"
          onClick={() => setDialog({ type: "team" })}
        >
          <Pencil />
        </Button>
        <RowMenu name="Members">
          <CopyUri uri={teamUri({ type: "members", teamId: team.id })} label="Copy members URI" />
          <DropdownMenuCheckboxItem checked={showModel} onCheckedChange={setShowModel}>
            Show model
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={showCredits} onCheckedChange={setShowCredits}>
            Show AI credits
          </DropdownMenuCheckboxItem>
        </RowMenu>
      </TeamPanelHeader>
      <p className="border-b px-4 py-2 text-xs text-muted-foreground">
        Click an agent&apos;s name to edit it. Hover its avatar to inspect live activity.
      </p>
      {selectedAgentId && !agents.some(({ id }) => id === selectedAgentId) && (
        <p role="alert" className="px-4 py-2 text-sm text-destructive">
          Agent unavailable. It no longer belongs to this team.
        </p>
      )}
      {showCredits && (
        <div className="space-y-1 border-b px-4 py-3 text-xs">
          <p>
            Total AI credits spent:{" "}
            <span className="font-medium tabular-nums">
              <CreditUsage
                usage={total}
                loading={usage.isPending}
                failed={usage.isError && !usage.data}
              />
            </span>
          </p>
          <p className="text-muted-foreground">
            Reported usage from current team members&apos; sessions, including the lead and native
            subagents. Providers without AI credit reports are not included. Updates every 5
            seconds.
          </p>
          {usage.isError && (
            <p role="alert" className="text-destructive">
              {usage.data
                ? "Unable to refresh AI credit usage. Showing the last reported values."
                : "Unable to load AI credit usage."}{" "}
              <button type="button" className="underline" onClick={() => void usage.refetch()}>
                Retry
              </button>
            </p>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          aria-label="Team members"
          className="w-full table-fixed text-left text-xs"
          style={{ minWidth }}
        >
          <thead className="sticky top-0 z-10 bg-panel text-muted-foreground">
            <tr className="border-b [&>th]:px-3 [&>th]:py-3 [&>th]:font-medium">
              <th scope="col" className="w-40">
                Agent
              </th>
              <th scope="col" className="w-20">
                State
              </th>
              <th scope="col">Current task</th>
              <th scope="col">Sub sessions</th>
              <th scope="col">Pending tasks</th>
              <th scope="col">Blocking</th>
              {showModel && (
                <th scope="col" className="w-48">
                  Model
                </th>
              )}
              {showCredits && (
                <th scope="col" className="w-32 text-right">
                  AI credits spent
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const activity = presence[agent.id] ?? { state: "idle" };
              const assigned = teamTasksForAgent(tasks, agent.id);
              const current = assigned.filter(({ status }) => status === "in_progress");
              const pending = assigned.filter(({ status }) => status === "pending");
              const blocked = assigned.filter(({ status }) => status === "blocked");
              const model =
                agent.id === lead.id
                  ? team.model
                  : members.find(({ id }) => id === agent.id)?.model;

              return (
                <tr
                  key={agent.id}
                  ref={agent.id === selectedAgentId ? selectedRef : undefined}
                  className={`border-b align-top [&>td]:px-3 [&>td]:py-3 ${agent.id === selectedAgentId ? "bg-accent/30" : ""}`}
                >
                  <td>
                    <AgentItem
                      agent={agent}
                      role="presentation"
                      showDetail={false}
                      onEdit={() =>
                        setDialog(
                          agent.id === lead.id
                            ? { type: "team" }
                            : { type: "member", agentId: agent.id },
                        )
                      }
                    />
                  </td>
                  <td className="capitalize">{activity.state}</td>
                  <td>
                    <TaskTitles
                      tasks={current}
                      empty={activity.state === "working" ? activity.text : undefined}
                    />
                  </td>
                  <td>
                    <SubSessionList sessions={subSessionsByOwner?.[agent.id] ?? []} />
                  </td>
                  <td>
                    <TaskTitles tasks={pending} />
                  </td>
                  <td>
                    {activity.state === "waiting" && (
                      <TruncatedText className="mb-1 text-amber-700 dark:text-amber-400">
                        Waiting for {activity.text}
                        {activity.wakeAt && (
                          <>
                            ; checks back at <ClockTime date={activity.wakeAt} />
                          </>
                        )}
                      </TruncatedText>
                    )}
                    {(blocked.length > 0 || activity.state !== "waiting") && (
                      <TaskTitles tasks={blocked} />
                    )}
                  </td>
                  {showModel && (
                    <td>
                      {model ? (
                        <TruncatedText>{formatModelConfiguration(model)}</TruncatedText>
                      ) : (
                        <span className="text-muted-foreground">Workspace default</span>
                      )}
                    </td>
                  )}
                  {showCredits && (
                    <td className="whitespace-nowrap text-right tabular-nums">
                      <CreditUsage
                        usage={usage.data?.[agent.id]}
                        loading={usage.isPending}
                        failed={usage.isError && !usage.data}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dialog?.type === "team" && (
        <TeamDialog
          team={team}
          onOpenChange={(open) => {
            if (!open) closeDialog();
          }}
        />
      )}
      {editingMember && <AgentEditor agent={editingMember} onClose={closeDialog} />}
      {dialog?.type === "new_member" && <AgentEditor teamId={team.id} onClose={closeDialog} />}
    </section>
  );
}

const CREDIT_FORMATTER = new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 });

function CreditUsage({
  usage,
  loading,
  failed,
}: {
  usage?: SessionUsage;
  loading: boolean;
  failed: boolean;
}) {
  if (loading) return <span className="text-muted-foreground">Loading...</span>;
  if (failed) return <span className="text-muted-foreground">Unavailable</span>;
  if (!usage || usage.status === "unavailable") {
    return <span className="text-muted-foreground">Not reported</span>;
  }
  return (
    <>
      {usage.aiCredits > 0 && usage.aiCredits < 0.000001
        ? "<0.000001"
        : CREDIT_FORMATTER.format(usage.aiCredits)}
      {usage.status === "partial" && <span className="text-muted-foreground"> (partial)</span>}
    </>
  );
}

function TaskTitles({ tasks, empty }: { tasks: readonly TeamTask[]; empty?: string }) {
  return tasks.length > 0 ? (
    <ul className="space-y-1">
      {tasks.map((task) => (
        <li key={task.id}>
          <TruncatedText>{task.title}</TruncatedText>
        </li>
      ))}
    </ul>
  ) : empty ? (
    <TruncatedText className="text-muted-foreground">{empty}</TruncatedText>
  ) : (
    <span className="text-muted-foreground">None</span>
  );
}
