// A service connector's use: its connection, the messages teams sent it and received from it
// recently, and the team threads that carried them.

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "@/shared/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/ui/dialog";
import { RelativeTime } from "@/shared/ui/relative-time";
import { summarizeConnectorUse, type ConnectorExchangeCounts } from "@teams/model/connectorUse";
import { teamUri } from "@teams/model/references";
import { teamQueries } from "@teams/queries";
import { useTeams } from "@teams/useTeams";
import { connectorHandle, type ConnectorEntry } from "../model";
import { CONNECTION_STATES, ConnectionDot, UseTile } from "./ConnectorUse";

/** Threads listed at most; the rest are counted. */
const SHOWN_THREADS = 20;

export function ServiceDialog({
  connector,
  onEdit,
  onOpenChange,
}: {
  connector: ConnectorEntry;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const records = useQuery(teamQueries.connectorUse(connector.id));
  const teams = useTeams();
  const teamName = (teamId: string) => teams.find(({ team }) => team.id === teamId)?.team.name;
  const use = records.data
    ? summarizeConnectorUse(records.data, new Date(records.dataUpdatedAt))
    : undefined;
  const pending = records.isPending ? "…" : "—";
  const counts = (kind: keyof ConnectorExchangeCounts) =>
    use ? `${use.day[kind]} / ${use.week[kind]}` : pending;
  const { status } = connector;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{connector.name}</DialogTitle>
          <DialogDescription>
            What teams send @{connectorHandle(connector)} and receive from it, and the threads those
            conversations live in.
          </DialogDescription>
        </DialogHeader>

        <p className="flex flex-wrap items-center gap-x-1.5 text-sm">
          <ConnectionDot state={status.state} />
          {CONNECTION_STATES[status.state]} <RelativeTime date={status.since} />
          {status.state !== "connected" && status.error && (
            <span className="text-muted-foreground">· {status.error}</span>
          )}
        </p>

        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
          <UseTile label="Queued now" value={String(connector.pending)} />
          <UseTile label="Received · 24 h / 7 days" value={counts("received")} />
          <UseTile label="Sent · 24 h / 7 days" value={counts("sent")} />
          <UseTile label="Undelivered · 24 h / 7 days" value={counts("undelivered")} />
        </dl>
        {records.isError && (
          <p role="alert" className="text-xs text-destructive">
            Couldn&apos;t load the counts.{" "}
            <button type="button" className="underline" onClick={() => void records.refetch()}>
              Retry
            </button>
          </p>
        )}

        <section aria-label="Conversations this week" className="space-y-2 text-xs">
          <h3 className="text-sm font-medium">Conversations this week</h3>
          {!use || use.threads.length === 0 ? (
            <p className="text-muted-foreground">{use ? "None yet." : pending}</p>
          ) : (
            <>
              <ul className="divide-y rounded-md border">
                {use.threads.slice(0, SHOWN_THREADS).map((thread) => {
                  const team = teamName(thread.teamId);
                  return (
                    <li
                      key={`${thread.teamId}:${thread.threadSequence}`}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1">
                        {team ? (
                          <Link
                            to="/"
                            search={{ teams: [thread.teamId] }}
                            hash={encodeURIComponent(
                              teamUri({
                                type: "message",
                                teamId: thread.teamId,
                                sequence: thread.threadSequence,
                              }),
                            )}
                            title="Open this thread"
                            className="line-clamp-2 font-medium hover:underline"
                            onClick={() => onOpenChange(false)}
                          >
                            {thread.excerpt}
                          </Link>
                        ) : (
                          <span className="line-clamp-2 font-medium">{thread.excerpt}</span>
                        )}
                        <span className="block text-muted-foreground">
                          {team ?? "Removed team"} · started by{" "}
                          {thread.openedBy === "connector" ? connector.name : "the team"}
                        </span>
                      </span>
                      <span className="shrink-0 text-right text-muted-foreground">
                        <ExchangeCounts counts={thread} />
                        <span className="block">
                          <RelativeTime date={thread.lastAt} />
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {use.threads.length > SHOWN_THREADS && (
                <p className="text-muted-foreground">
                  And {use.threads.length - SHOWN_THREADS} more this week.
                </p>
              )}
            </>
          )}
        </section>

        <section aria-label="This week by team" className="space-y-2 text-xs">
          <h3 className="text-sm font-medium">This week, by team</h3>
          {!use || use.byTeam.length === 0 ? (
            <p className="text-muted-foreground">{use ? "None yet." : pending}</p>
          ) : (
            <ul className="space-y-1">
              {use.byTeam.map((entry) => (
                <li key={entry.teamId} className="flex justify-between gap-4">
                  <span>{teamName(entry.teamId) ?? "Removed team"}</span>
                  <ExchangeCounts counts={entry} />
                </li>
              ))}
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

function ExchangeCounts({
  counts: { received, sent, undelivered },
}: {
  counts: ConnectorExchangeCounts;
}) {
  return (
    <span className="tabular-nums">
      {received} received · {sent} sent
      {undelivered > 0 && <span className="text-destructive"> · {undelivered} undelivered</span>}
    </span>
  );
}
