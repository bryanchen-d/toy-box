// An agent pool's use: its nodes, the sub sessions open on them now with whoever owns each, and how
// many opened and closed recently.

import { useQuery } from "@tanstack/react-query";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { cn } from "@/shared/utils";
import { sessionQueries } from "@sessions/queries";
import { useTeams } from "@teams/useTeams";
import { countSubSessionUse } from "@workers/model/subSessions";
import { workerQueries } from "@workers/queries";
import {
  SubSessionStatus,
  useNodeSubSessions,
  type NodeSubSession,
} from "@workers/components/SubSessions";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { poolNodes, type ConnectorEntry } from "../model";

export function PoolDialog({
  connector,
  onEdit,
  onOpenChange,
}: {
  connector: ConnectorEntry;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const nodes = poolNodes(connector);
  const nodeNames = nodes.map(({ name }) => name);
  const open = useNodeSubSessions(nodeNames);
  const history = useQuery(workerQueries.subSessionHistory());
  const ownerOf = useOwnerNames();
  const use = history.data
    ? countSubSessionUse(
        history.data.filter(({ node }) => node !== undefined && nodeNames.includes(node)),
        new Date(history.dataUpdatedAt),
      )
    : undefined;
  const pending = history.isPending ? "…" : "—";

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{connector.name}</DialogTitle>
          <DialogDescription>
            The sub sessions agents run on this pool&apos;s nodes, and who owns each.
          </DialogDescription>
        </DialogHeader>

        <ul aria-label="Nodes" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {nodes.map((node) => (
            <li key={node.name} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className={cn(
                  "size-2 rounded-full",
                  node.state === "connected"
                    ? "bg-green-500"
                    : node.state === "unreachable"
                      ? "bg-destructive"
                      : "bg-amber-500",
                )}
              />
              {node.name}
              <span className="text-muted-foreground">
                · {NODE_STATES[node.state]}
                {node.draining ? " · draining" : ""}
              </span>
            </li>
          ))}
        </ul>

        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <Tile label="Working now" value={String(open.filter(({ working }) => working).length)} />
          <Tile label="Open now" value={String(open.length)} />
          <Tile
            label="Created · 24 h / 7 days"
            value={use ? `${use.day.created} / ${use.week.created}` : pending}
          />
          <Tile
            label="Closed · 24 h / 7 days"
            value={use ? `${use.day.closed} / ${use.week.closed}` : pending}
          />
        </dl>
        {history.isError && (
          <p role="alert" className="text-xs text-destructive">
            Couldn&apos;t load the counts.{" "}
            <button type="button" className="underline" onClick={() => void history.refetch()}>
              Retry
            </button>
          </p>
        )}

        <section aria-label="Open sub sessions" className="space-y-2 text-xs">
          <h3 className="text-sm font-medium">Open sub sessions</h3>
          {open.length === 0 ? (
            <p className="text-muted-foreground">None right now.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {[...open]
                .sort(
                  (left, right) =>
                    Number(right.working) - Number(left.working) ||
                    right.session.createdAt.getTime() - left.session.createdAt.getTime(),
                )
                .map((subSession) => (
                  <OpenSubSession
                    key={subSession.session.id}
                    subSession={subSession}
                    owner={ownerOf(subSession.ownerSessionId)}
                    onOpened={() => onOpenChange(false)}
                  />
                ))}
            </ul>
          )}
        </section>

        <section aria-label="Created this week by owner" className="space-y-2 text-xs">
          <h3 className="text-sm font-medium">Created this week, by owner</h3>
          {!use || use.byOwner.length === 0 ? (
            <p className="text-muted-foreground">{use ? "None yet." : pending}</p>
          ) : (
            <ul className="space-y-1">
              {use.byOwner.map(({ ownerSessionId, teamId, created }) => {
                const owner = ownerOf(ownerSessionId, teamId);
                return (
                  <li key={ownerSessionId} className="flex justify-between gap-4">
                    <span>
                      {owner.name}
                      {owner.team && <span className="text-muted-foreground"> · {owner.team}</span>}
                    </span>
                    <span className="tabular-nums">{created}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onEdit}>
            Edit connector
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NODE_STATES = {
  connected: "Connected",
  connecting: "Connecting",
  unreachable: "Unreachable",
} as const;

function OpenSubSession({
  subSession: { session },
  owner,
  onOpened,
}: {
  subSession: NodeSubSession;
  owner: OwnerName;
  onOpened: () => void;
}) {
  const { openSession } = useWorkspaceSurface();
  const title = session.title || "Sub session";
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2">
      <span className="min-w-0">
        {openSession ? (
          <button
            type="button"
            className="text-left font-medium hover:underline"
            title={`Open ${title}`}
            onClick={() => {
              openSession(session.id);
              onOpened();
            }}
          >
            {title}
          </button>
        ) : (
          <span className="font-medium">{title}</span>
        )}
        <span className="block text-muted-foreground">
          {owner.name}
          {owner.team ? ` · ${owner.team}` : ""}
        </span>
      </span>
      <SubSessionStatus session={session} />
    </li>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

type OwnerName = { name: string; team?: string };

/** Names a sub session's owner: a team agent and its team, or the session that owns it. */
function useOwnerNames(): (ownerSessionId: string, teamId?: string) => OwnerName {
  const teams = useTeams();
  const { data: sessions } = useQuery({
    ...sessionQueries.state(),
    select: (state) => state.sessions,
  });
  return (ownerSessionId, teamId) => {
    for (const { team, agents } of teams) {
      const agent = agents.find(({ id }) => id === ownerSessionId);
      if (agent) return { name: agent.name, team: team.name };
    }
    const team = teams.find((entry) => entry.team.id === teamId)?.team;
    if (team) return { name: "Removed agent", team: team.name };
    const session = sessions?.find(({ id }) => id === ownerSessionId);
    return { name: session ? session.title || "Untitled session" : "Closed session" };
  };
}
