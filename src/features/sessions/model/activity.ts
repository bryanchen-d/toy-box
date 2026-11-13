// How canonical session events become hourly activity. The live runtime and history backfills
// fold the same timestamped events through `observeActivity`, so both agree on what a turn is,
// how long a session worked, and what it spent.

import type { SessionEvent, SessionStatus } from "./index";

/** What one session did within one UTC hour. */
export type ActivityHour = {
  /** ISO timestamp of the hour's start. */
  hour: string;
  /** Turns started: each time the session began working after being ready for input. */
  turns: number;
  /** Time spent working, until the session was ready for input again or ended. */
  busyMs: number;
  aiCredits: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

/** What interpreting later events requires; reported activity is returned as hours. */
export type SessionActivity = {
  /** When the running turn's unreported busy time began; absent while ready for input. */
  busySince?: number;
  /** Credits already reported, so a cumulative total reports only its increase. */
  aiCredits: number;
};

type ActivityCounts = Omit<ActivityHour, "hour">;
type Observation = { activity: SessionActivity; hours: ActivityHour[] };

const HOUR_MS = 60 * 60 * 1000;
// A background session is ready for input while its background work continues.
const READY_STATUSES: ReadonlySet<SessionStatus> = new Set(["idle", "background"]);

/** Begin observing a session that has already spent `aiCredits`, such as one resumed from history. */
export function createSessionActivity(aiCredits = 0): SessionActivity {
  return { aiCredits };
}

/**
 * Observe one event at `at` (epoch milliseconds) and return the activity it reveals. Each report
 * includes the running turn's busy time so far, so reported hours never wait for a turn to end.
 */
export function observeActivity(
  activity: SessionActivity,
  event: SessionEvent,
  at: number,
): Observation {
  switch (event.type) {
    case "status":
      return READY_STATUSES.has(event.status)
        ? stopWorking(activity, at)
        : startWorking(activity, at);
    case "end":
      return stopWorking(activity, at);
    case "usage": {
      const aiCredits =
        event.mode === "delta"
          ? event.usage.aiCredits
          : Math.max(0, event.usage.aiCredits - activity.aiCredits);
      const tokens = event.mode === "delta" ? event.tokens : undefined;
      if (aiCredits === 0 && !tokens) return { activity, hours: [] };
      const spent = hourAt(at, {
        aiCredits,
        inputTokens: tokens?.input ?? 0,
        outputTokens: tokens?.output ?? 0,
        cacheReadTokens: tokens?.cacheRead ?? 0,
        cacheWriteTokens: tokens?.cacheWrite ?? 0,
      });
      const { busySince } = activity;
      return {
        activity: {
          aiCredits: activity.aiCredits + aiCredits,
          ...(busySince === undefined ? {} : { busySince: at }),
        },
        hours: sumActivityHours(
          busySince === undefined ? [spent] : [...busyHours(busySince, at), spent],
        ),
      };
    }
    default:
      return { activity, hours: [] };
  }
}

/** Combine activity reported for the same hours, ordered by hour. */
export function sumActivityHours(hours: Iterable<ActivityHour>): ActivityHour[] {
  const sums = new Map<string, ActivityHour>();
  for (const hour of hours) {
    const sum = sums.get(hour.hour);
    sums.set(hour.hour, sum ? addCounts(sum, hour) : hour);
  }
  return [...sums.values()].sort((left, right) => (left.hour < right.hour ? -1 : 1));
}

function startWorking(activity: SessionActivity, at: number): Observation {
  if (activity.busySince !== undefined) return { activity, hours: [] };
  return { activity: { ...activity, busySince: at }, hours: [hourAt(at, { turns: 1 })] };
}

function stopWorking(activity: SessionActivity, at: number): Observation {
  if (activity.busySince === undefined) return { activity, hours: [] };
  return {
    activity: { aiCredits: activity.aiCredits },
    hours: busyHours(activity.busySince, at),
  };
}

/** Split busy time across the UTC hours it spans. */
function busyHours(from: number, to: number): ActivityHour[] {
  const hours: ActivityHour[] = [];
  for (let start = hourStart(from); start < to; start += HOUR_MS) {
    const busyMs = Math.min(to, start + HOUR_MS) - Math.max(from, start);
    if (busyMs > 0) hours.push(hourAt(start, { busyMs }));
  }
  return hours;
}

function hourAt(at: number, counts: Partial<ActivityCounts>): ActivityHour {
  return addCounts(
    {
      hour: new Date(hourStart(at)).toISOString(),
      turns: 0,
      busyMs: 0,
      aiCredits: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    counts,
  );
}

function addCounts(hour: ActivityHour, counts: Partial<ActivityCounts>): ActivityHour {
  return {
    hour: hour.hour,
    turns: hour.turns + (counts.turns ?? 0),
    busyMs: hour.busyMs + (counts.busyMs ?? 0),
    aiCredits: hour.aiCredits + (counts.aiCredits ?? 0),
    inputTokens: hour.inputTokens + (counts.inputTokens ?? 0),
    outputTokens: hour.outputTokens + (counts.outputTokens ?? 0),
    cacheReadTokens: hour.cacheReadTokens + (counts.cacheReadTokens ?? 0),
    cacheWriteTokens: hour.cacheWriteTokens + (counts.cacheWriteTokens ?? 0),
  };
}

function hourStart(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}
