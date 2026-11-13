// A team's performance over recent hours, days, or weeks, derived from its public transcript, the
// wakes it recorded with how each was delivered, and the runtime activity Sessions records for each
// agent. Nothing here is stored: those records stay the only sources, and this projection is
// recomputed for each view.

import {
  isTeamSystemMessage,
  messageAuthorId,
  resolveTeamAudience,
  type TeamAgent,
  type TeamMessage,
} from ".";

export const PERFORMANCE_BUCKETS = ["hour", "day", "week"] as const;
export type PerformanceBucket = (typeof PERFORMANCE_BUCKETS)[number];

/** How many buckets each granularity covers, ending with the current one. */
const BUCKET_COUNTS: Record<PerformanceBucket, number> = { hour: 24, day: 14, week: 12 };

/** One agent's runtime activity in one UTC hour, as Sessions records it. */
export type AgentActivityHour = RuntimeActivity & { sessionId: string; hour: string };

export type RuntimeActivity = {
  turns: number;
  busyMs: number;
  aiCredits: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/**
 * How a wake reached its agent: `started` a turn while the agent was idle, `steered` the turn it was
 * running by joining it at its next step without stopping current work, or `queued` behind that
 * turn.
 */
export const WAKE_DELIVERIES = ["started", "steered", "queued"] as const;
export type WakeDelivery = (typeof WAKE_DELIVERIES)[number];
export type Deliveries = Record<WakeDelivery, number>;

/** One recorded wake of an agent. */
export type TeamWake = {
  agentId: string;
  at: string;
  cause: "message" | "routine" | "follow_up";
  /** The waking message's author key; absent for scheduled wakes. */
  author?: string;
  delivery: WakeDelivery;
};

/** One bucket of activity, keyed by the author or agent it belongs to. */
export type PerformancePoint = {
  /** The bucket's local start. */
  start: string;
  /** Public messages by author: an agent, connector, or team ID, or "user". */
  messages: Record<string, number>;
  /** Messages that routed to each agent, waking it. */
  wakes: Record<string, number>;
  /** Recorded wakes of each agent by how they were delivered, including scheduled ones. */
  deliveries: Record<string, Deliveries>;
  /** Each agent's reply times, in milliseconds, for the wakes that arrived in this bucket. */
  responses: Record<string, number[]>;
  runtime: Record<string, RuntimeActivity>;
};

export type AgentPerformance = {
  agentId: string;
  messages: number;
  wakes: number;
  /** Wakes the agent followed with a public message of its own. */
  answered: number;
  /** From a wake to the agent's next public message. */
  medianResponseMs: number | null;
  p90ResponseMs: number | null;
  deliveries: Deliveries;
  runtime: RuntimeActivity;
};

/** How one author's messages reached one agent. */
export type TeamAddress = {
  from: string;
  to: string;
  /** Messages that routed from the author to the agent. */
  count: number;
  /** Recorded deliveries of those messages. */
  deliveries: Deliveries;
  medianResponseMs: number | null;
  p90ResponseMs: number | null;
};

export type TeamPerformance = {
  bucket: PerformanceBucket;
  from: string;
  to: string;
  agents: AgentPerformance[];
  series: PerformancePoint[];
  addresses: TeamAddress[];
};

/** The author key the projection counts a message under. */
export const USER_AUTHOR = "user";

export const EMPTY_RUNTIME: RuntimeActivity = {
  turns: 0,
  busyMs: 0,
  aiCredits: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const EMPTY_DELIVERIES: Deliveries = { started: 0, steered: 0, queued: 0 };

export const AGGREGATIONS = ["p50", "p90", "mean", "max"] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

/** One summary of a sample, or null without any values. */
export function aggregate(values: readonly number[], aggregation: Aggregation): number | null {
  if (values.length === 0) return null;
  switch (aggregation) {
    case "mean":
      return values.reduce((sum, value) => sum + value, 0) / values.length;
    case "max":
      return Math.max(...values);
    default: {
      const sorted = [...values].sort((left, right) => left - right);
      const rank = aggregation === "p50" ? 0.5 : 0.9;
      return sorted[Math.max(0, Math.ceil(rank * sorted.length) - 1)]!;
    }
  }
}

/** The local start of the bucket holding `date`. Weeks start on Monday. */
export function bucketStart(date: Date, bucket: PerformanceBucket): Date {
  const start = new Date(date);
  start.setMinutes(0, 0, 0);
  if (bucket === "hour") return start;
  start.setHours(0);
  if (bucket === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  return start;
}

/** The local start of the bucket after the one starting at `start`. */
export function nextBucketStart(start: Date, bucket: PerformanceBucket): Date {
  const next = new Date(start);
  if (bucket === "hour") next.setHours(next.getHours() + 1);
  else next.setDate(next.getDate() + (bucket === "week" ? 7 : 1));
  return next;
}

/** The buckets a view covers, oldest first, ending with the one holding `now`. */
export function performanceWindow(now: Date, bucket: PerformanceBucket): Date[] {
  const starts = [bucketStart(now, bucket)];
  while (starts.length < BUCKET_COUNTS[bucket]) {
    const previous = new Date(starts[0]!);
    if (bucket === "hour") previous.setHours(previous.getHours() - 1);
    else previous.setDate(previous.getDate() - (bucket === "week" ? 7 : 1));
    starts.unshift(bucketStart(previous, bucket));
  }
  return starts;
}

/**
 * Counts each author's messages and each agent's wakes per bucket, measures how long agents take to
 * answer a wake publicly, records who addresses whom, counts how recorded wakes were delivered, and
 * adds runtime activity. Audiences follow the current roster, so a message routes as it would today.
 */
export function projectTeamPerformance(
  messages: readonly TeamMessage<unknown>[],
  {
    lead,
    members,
    bucket,
    starts,
    wakes = [],
    activity = [],
  }: {
    lead: TeamAgent;
    members: readonly TeamAgent[];
    bucket: PerformanceBucket;
    /** The window's bucket starts, oldest first. */
    starts: readonly Date[];
    wakes?: readonly TeamWake[];
    activity?: readonly AgentActivityHour[];
  },
): TeamPerformance {
  const from = starts[0]!;
  const to = nextBucketStart(starts.at(-1)!, bucket);
  const series = starts.map((start): PerformancePoint => ({
    start: start.toISOString(),
    messages: {},
    wakes: {},
    deliveries: {},
    responses: {},
    runtime: {},
  }));
  const pointAt = (time: Date) => {
    if (time < from || time >= to) return undefined;
    const start = bucketStart(time, bucket).getTime();
    return series.find((point) => Date.parse(point.start) === start);
  };

  type Totals = Omit<AgentPerformance, "medianResponseMs" | "p90ResponseMs"> & {
    durations: number[];
  };
  const totals = new Map<string, Totals>();
  const totalsFor = (agentId: string) => {
    let total = totals.get(agentId);
    if (!total) {
      total = {
        agentId,
        messages: 0,
        wakes: 0,
        answered: 0,
        deliveries: { ...EMPTY_DELIVERIES },
        runtime: { ...EMPTY_RUNTIME },
        durations: [],
      };
      totals.set(agentId, total);
    }
    return total;
  };
  for (const { id } of [lead, ...members]) totalsFor(id);

  type Pair = Omit<TeamAddress, "medianResponseMs" | "p90ResponseMs"> & { durations: number[] };
  const pairs = new Map<string, Pair>();
  const pairFor = (author: string, agentId: string) => {
    const key = `${author}\u0000${agentId}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = {
        from: author,
        to: agentId,
        count: 0,
        deliveries: { ...EMPTY_DELIVERIES },
        durations: [],
      };
      pairs.set(key, pair);
    }
    return pair;
  };

  type PendingWake = { at: number; author: string; point: PerformancePoint };
  const pendingWakes = new Map<string, PendingWake[]>();

  for (const message of [...messages].sort((left, right) => left.sequence - right.sequence)) {
    if (isTeamSystemMessage(message)) continue;
    const time = new Date(message.timestamp);
    const point = pointAt(time);
    if (!point) continue;
    const author = messageAuthorId(message.sender) ?? USER_AUTHOR;
    point.messages[author] = (point.messages[author] ?? 0) + 1;

    if (message.sender.type === "agent") {
      const total = totalsFor(author);
      total.messages += 1;
      for (const wake of pendingWakes.get(author) ?? []) {
        const duration = time.getTime() - wake.at;
        total.answered += 1;
        total.durations.push(duration);
        (wake.point.responses[author] ??= []).push(duration);
        pairFor(wake.author, author).durations.push(duration);
      }
      pendingWakes.delete(author);
    }

    const audience = resolveTeamAudience({
      content: message.content,
      sender: message.sender,
      lead,
      members,
    });
    for (const { id } of audience) {
      totalsFor(id).wakes += 1;
      point.wakes[id] = (point.wakes[id] ?? 0) + 1;
      pairFor(author, id).count += 1;
      const waiting = pendingWakes.get(id) ?? [];
      waiting.push({ at: time.getTime(), author, point });
      pendingWakes.set(id, waiting);
    }
  }

  for (const wake of wakes) {
    const point = pointAt(new Date(wake.at));
    if (!point) continue;
    totalsFor(wake.agentId).deliveries[wake.delivery] += 1;
    const deliveries = (point.deliveries[wake.agentId] ??= { ...EMPTY_DELIVERIES });
    deliveries[wake.delivery] += 1;
    if (wake.author !== undefined)
      pairFor(wake.author, wake.agentId).deliveries[wake.delivery] += 1;
  }

  for (const hour of activity) {
    const point = pointAt(new Date(hour.hour));
    if (!point) continue;
    const { sessionId, hour: _hour, ...runtime } = hour;
    point.runtime[sessionId] = addRuntime(point.runtime[sessionId] ?? EMPTY_RUNTIME, runtime);
    const total = totalsFor(sessionId);
    total.runtime = addRuntime(total.runtime, runtime);
  }

  return {
    bucket,
    from: from.toISOString(),
    to: to.toISOString(),
    agents: [...totals.values()].map(({ durations, ...total }) => ({
      ...total,
      medianResponseMs: aggregate(durations, "p50"),
      p90ResponseMs: aggregate(durations, "p90"),
    })),
    series,
    addresses: [...pairs.values()]
      .map(({ durations, ...pair }) => ({
        ...pair,
        medianResponseMs: aggregate(durations, "p50"),
        p90ResponseMs: aggregate(durations, "p90"),
      }))
      .sort((left, right) => right.count - left.count || left.from.localeCompare(right.from)),
  };
}

export function addRuntime(left: RuntimeActivity, right: RuntimeActivity): RuntimeActivity {
  return {
    turns: left.turns + right.turns,
    busyMs: left.busyMs + right.busyMs,
    aiCredits: left.aiCredits + right.aiCredits,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
  };
}
