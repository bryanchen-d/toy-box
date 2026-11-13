// Durable hourly session activity. Live runtimes record what each event reveals as it happens;
// a backfill reconstructs earlier activity from timestamped history, such as Copilot's native
// log. Rows are additive increments, keyed by session and UTC hour, and outlive the session.

import type { SessionEvent } from "@sessions/model";
import {
  createSessionActivity,
  observeActivity,
  sumActivityHours,
  type ActivityHour,
} from "@sessions/model/activity";
import { getStateDatabase, inStateTransaction } from "@/server/database";

export type SessionActivityHour = { sessionId: string } & ActivityHour;

/** Hours in [from, to) for the given sessions, ordered by hour then sessionId. */
export async function listSessionActivity(
  sessionIds: readonly string[],
  from: Date,
  to: Date,
): Promise<SessionActivityHour[]> {
  const db = await getStateDatabase({ createIfMissing: false });
  if (!db || sessionIds.length === 0) return [];
  const rows = await db<ActivityRow[]>`
    SELECT * FROM session_activity_hours
    WHERE session_id IN (SELECT value FROM json_each(${JSON.stringify(sessionIds)}))
      AND hour >= ${from.getTime()} AND hour < ${to.getTime()}
    ORDER BY hour, session_id
  `;
  return rows.map(fromRow);
}

/** Add activity a session reported; repeated and concurrent reports accumulate. */
export async function recordSessionActivity(
  sessionId: string,
  hours: readonly ActivityHour[],
): Promise<void> {
  const db = await getStateDatabase({ createIfMissing: false });
  if (db && hours.length > 0) await addHours(db, sessionId, hours);
}

/**
 * Replace a session's activity within the hours its history covers with that history's activity,
 * so rerunning is safe. Pass history in time order, such as `readCopilotActivity(path)`. Run it
 * while the session is idle; live reports made during it may be lost or doubled.
 */
export async function backfillSessionActivity(
  sessionId: string,
  history: AsyncIterable<{ at: number; event: SessionEvent }>,
  db?: Bun.SQL,
): Promise<ActivityHour[]> {
  let activity = createSessionActivity();
  const reported: ActivityHour[] = [];
  for await (const { at, event } of history) {
    const observed = observeActivity(activity, event, at);
    activity = observed.activity;
    reported.push(...observed.hours);
  }
  const hours = sumActivityHours(reported);
  const [first, last] = [hours[0], hours.at(-1)];
  if (!first || !last) return hours;

  await inStateTransaction(db ?? (await getStateDatabase()), async (transaction) => {
    await transaction`
      DELETE FROM session_activity_hours
      WHERE session_id = ${sessionId}
        AND hour BETWEEN ${Date.parse(first.hour)} AND ${Date.parse(last.hour)}
    `;
    await addHours(transaction, sessionId, hours);
  });
  return hours;
}

// Nine parameters per row stays well below SQLite's 32,766 variable limit.
const ROWS_PER_STATEMENT = 1000;

async function addHours(db: Bun.SQL, sessionId: string, hours: readonly ActivityHour[]) {
  for (let start = 0; start < hours.length; start += ROWS_PER_STATEMENT) {
    const rows = hours
      .slice(start, start + ROWS_PER_STATEMENT)
      .map((hour) => toRow(sessionId, hour));
    await db`
      INSERT INTO session_activity_hours ${db(rows)}
      ON CONFLICT (session_id, hour) DO UPDATE SET
        turns = turns + excluded.turns,
        busy_ms = busy_ms + excluded.busy_ms,
        ai_credits = ai_credits + excluded.ai_credits,
        input_tokens = input_tokens + excluded.input_tokens,
        output_tokens = output_tokens + excluded.output_tokens,
        cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
        cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens
    `;
  }
}

type ActivityRow = {
  session_id: string;
  hour: number;
  turns: number;
  busy_ms: number;
  ai_credits: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

function toRow(sessionId: string, hour: ActivityHour): ActivityRow {
  return {
    session_id: sessionId,
    hour: Date.parse(hour.hour),
    turns: hour.turns,
    busy_ms: hour.busyMs,
    ai_credits: hour.aiCredits,
    input_tokens: hour.inputTokens,
    output_tokens: hour.outputTokens,
    cache_read_tokens: hour.cacheReadTokens,
    cache_write_tokens: hour.cacheWriteTokens,
  };
}

function fromRow(row: ActivityRow): SessionActivityHour {
  return {
    sessionId: row.session_id,
    hour: new Date(row.hour).toISOString(),
    turns: row.turns,
    busyMs: row.busy_ms,
    aiCredits: row.ai_credits,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
  };
}
