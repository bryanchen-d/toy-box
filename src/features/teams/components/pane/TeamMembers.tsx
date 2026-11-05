import { useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserMinus, UserPlus, Users } from "lucide-react";
import { AgentEditor } from "@teams/components/agents/AgentEditor";
import { AgentItem } from "@teams/components/agents/AgentItem";
import { TeamDialog } from "@teams/components/TeamDialog";
import { teamTasksForAgent, compareTeamAgents, type Team, type TeamTask } from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { formatModelConfiguration } from "@providers/model";
import { teamQueries } from "@teams/queries";
import { sumSessionUsage, type SessionUsage } from "@sessions/model/usage";
import { DestructiveConfirmationDialog } from "@/shared/sidebar/DestructiveConfirmationDialog";
import { Button } from "@/shared/ui/button";
import { ClockTime } from "@/shared/ui/clock-time";
import { useTeamPane } from "./TeamPaneContext";
import { TeamPanelHeader } from "./TeamPanelHeader";
import { CopyTeamUri } from "@teams/components/CopyTeamUri";
import { RowMenu } from "./overview/RowMenu";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/shared/ui/dropdown-menu";

export function TeamMembers({
  team,
  onClose,
  isVisible = true,
  selectedAgentId,
}: {
  team: Team;
  onClose: () => void;
  isVisible?: boolean;
  selectedAgentId?: string;
}) {
  const { lead, members, presence, mention } = useTeamPane();
  const [editingId, setEditingId] = useState<string>();
  const [removingId, setRemovingId] = useState<string>();
  const [showModel, setShowModel] = useState(true);
  const [showCredits, setShowCredits] = useState(false);
  const editingMember = members.find(({ id }) => id === editingId);
  const removingMember = members.find(({ id }) => id === removingId);
  const agents = [lead, ...[...members].sort(compareTeamAgents)];
  const usage = useQuery({
    ...teamQueries.usage(team.id),
    enabled: isVisible && showCredits,
  });
  const total = sumSessionUsage(agents.map((agent) => usage.data?.[agent.id]));
  const selectedRef = useRef<HTMLTableRowElement>(null);
  useLayoutEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "center" });
  }, [selectedAgentId]);

  return (
    <section
      aria-label={`Team members in #${team.name}`}
      className="flex h-full min-h-0 min-w-0 flex-col bg-panel"
    >
      <TeamPanelHeader
        icon={Users}
        title={`Team members (${agents.length})`}
        closeLabel="Close team members"
        onClose={onClose}
      >
        <RowMenu name="Members">
          <CopyTeamUri target={{ type: "members", teamId: team.id }} label="Copy members URI" />
          <DropdownMenuCheckboxItem checked={showModel} onCheckedChange={setShowModel}>
            Show model
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={showCredits} onCheckedChange={setShowCredits}>
            Show AI credits
          </DropdownMenuCheckboxItem>
        </RowMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Add an agent"
          title="Add an agent"
          disabled={team.paused}
          onClick={mention}
        >
          <UserPlus />
        </Button>
      </TeamPanelHeader>
      <p className="border-b px-4 py-2 text-xs text-muted-foreground">
        Model settings apply on the next turn. Hover an agent to inspect live activity.
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
        <table aria-label="Team members" className="w-full min-w-[54rem] text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel text-muted-foreground">
            <tr className="border-b [&>th]:px-3 [&>th]:py-3 [&>th]:font-medium">
              <th scope="col">Agent</th>
              <th scope="col">State</th>
              <th scope="col">Current task</th>
              <th scope="col">Pending tasks</th>
              <th scope="col">Blocking</th>
              {showModel && <th scope="col">Model</th>}
              {showCredits && (
                <th scope="col" className="text-right">
                  AI credits spent
                </th>
              )}
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const activity = presence[agent.id] ?? { state: "idle" };
              const tasks = teamTasksForAgent(team.tasks, agent.id);
              const current = tasks.filter(({ status }) => status === "in_progress");
              const pending = tasks.filter(({ status }) => status === "pending");
              const blocked = tasks.filter(({ status }) => status === "blocked");
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
                  <td className="min-w-40">
                    <AgentItem agent={agent} role="presentation" showDetail={false} />
                  </td>
                  <td className="capitalize">{activity.state}</td>
                  <td className="max-w-64">
                    <TaskTitles
                      tasks={current}
                      empty={activity.state === "working" ? activity.text : undefined}
                    />
                  </td>
                  <td className="max-w-64">
                    <TaskTitles tasks={pending} />
                  </td>
                  <td className="max-w-64">
                    {activity.state === "waiting" && (
                      <p className="mb-1 text-amber-700 dark:text-amber-400">
                        Waiting for {activity.text}
                        {activity.wakeAt && (
                          <>
                            ; checks back at <ClockTime date={activity.wakeAt} />
                          </>
                        )}
                      </p>
                    )}
                    {(blocked.length > 0 || activity.state !== "waiting") && (
                      <TaskTitles tasks={blocked} />
                    )}
                  </td>
                  {showModel && (
                    <td className="max-w-60 break-words">
                      {model ? (
                        formatModelConfiguration(model)
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
                  <td>
                    <RowMenu name={agent.name}>
                      <CopyTeamUri
                        target={{ type: "agent", teamId: team.id, agentId: agent.id }}
                        label="Copy agent URI"
                      />
                      <DropdownMenuItem onClick={() => setEditingId(agent.id)}>
                        Edit {agent.name}
                      </DropdownMenuItem>
                      {agent.id !== lead.id && (
                        <>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setRemovingId(agent.id)}
                          >
                            <UserMinus /> Remove from team
                          </DropdownMenuItem>
                        </>
                      )}
                    </RowMenu>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editingId === lead.id && (
        <TeamDialog
          team={team}
          onOpenChange={(open) => {
            if (!open) setEditingId(undefined);
          }}
        />
      )}
      {editingMember && (
        <AgentEditor agent={editingMember} onClose={() => setEditingId(undefined)} />
      )}
      {removingMember && (
        <DestructiveConfirmationDialog
          key={removingMember.id}
          title={`Remove ${removingMember.name}?`}
          description={`This removes ${removingMember.name} from #${team.name} and deletes their private team session. Their messages and reactions remain attributed to Deleted agent.`}
          confirmLabel="Remove"
          pendingLabel="Removing…"
          mutation={teamMutations.removeMember(removingMember.id)}
          onOpenChange={(open) => {
            if (!open) setRemovingId(undefined);
          }}
        />
      )}
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
        <li key={task.id}>{task.title}</li>
      ))}
    </ul>
  ) : (
    <span className="text-muted-foreground">{empty ?? "None"}</span>
  );
}
