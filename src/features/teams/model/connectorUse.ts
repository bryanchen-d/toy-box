// How teams used a service connector recently: the messages that passed between them and it, and
// the team threads that held those conversations, as Teams records them.

const DAY_MS = 24 * 60 * 60_000;

/** How far back a connector's use is counted. */
export const CONNECTOR_USE_MS = 7 * DAY_MS;

/**
 * One message that passed between a team and a connector: one the team sent it, an event it sent
 * the team, or one the team sent that it never received.
 */
export type ConnectorExchange = {
  kind: "sent" | "received" | "undelivered";
  teamId: string;
  /** The thread holding its conversation, which an undelivered message may have lost. */
  threadSequence?: number;
  at: string;
};

/** A team thread holding a conversation with the connector. */
export type ConnectorThread = {
  teamId: string;
  threadSequence: number;
  /** Whether the connector or the team started the thread. */
  openedBy: "connector" | "team";
  /** The thread's first message, shortened. */
  excerpt: string;
};

/** A connector's last week as Teams recorded it. */
export type ConnectorUseRecords = {
  threads: ConnectorThread[];
  exchanges: ConnectorExchange[];
};

export type ConnectorExchangeCounts = Record<ConnectorExchange["kind"], number>;

/**
 * How teams used a connector: the messages that passed each way in the last day and week, the
 * week's threads with what passed in each, most recently active first, and the week's messages by
 * team, busiest first.
 */
export function summarizeConnectorUse(
  { threads, exchanges }: ConnectorUseRecords,
  now: Date,
): {
  day: ConnectorExchangeCounts;
  week: ConnectorExchangeCounts;
  threads: (ConnectorThread & ConnectorExchangeCounts & { lastAt: string })[];
  byTeam: ({ teamId: string } & ConnectorExchangeCounts)[];
} {
  const week = exchanges.filter(({ at }) => Date.parse(at) >= now.getTime() - CONNECTOR_USE_MS);
  const day = week.filter(({ at }) => Date.parse(at) >= now.getTime() - DAY_MS);
  return {
    day: count(day),
    week: count(week),
    threads: threads
      .map((thread) => {
        const passed = week.filter(
          ({ teamId, threadSequence }) =>
            teamId === thread.teamId && threadSequence === thread.threadSequence,
        );
        const lastAt = passed
          .map(({ at }) => at)
          .sort()
          .at(-1);
        return lastAt ? { ...thread, ...count(passed), lastAt } : undefined;
      })
      .filter((thread) => thread !== undefined)
      .sort((left, right) => right.lastAt.localeCompare(left.lastAt)),
    byTeam: [...new Set(week.map(({ teamId }) => teamId))]
      .map((teamId) => ({
        teamId,
        ...count(week.filter((exchange) => exchange.teamId === teamId)),
      }))
      .sort((left, right) => total(right) - total(left) || left.teamId.localeCompare(right.teamId)),
  };
}

function count(exchanges: readonly ConnectorExchange[]): ConnectorExchangeCounts {
  const counts = { sent: 0, received: 0, undelivered: 0 };
  for (const { kind } of exchanges) counts[kind] += 1;
  return counts;
}

function total({ sent, received, undelivered }: ConnectorExchangeCounts): number {
  return sent + received + undelivered;
}
