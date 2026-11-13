import { expect, onTestFinished, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as database from "@/server/database";
import { readCopilotActivity } from "@providers/server/copilot/activity";
import type { ActivityHour } from "@sessions/model/activity";
import { backfillSessionActivity, listSessionActivity, recordSessionActivity } from "./activity";

async function useTestDatabase(): Promise<Bun.SQL> {
  const db = await database.createTestDatabase();
  const spy = spyOn(database, "getStateDatabase").mockResolvedValue(db);
  onTestFinished(async () => {
    spy.mockRestore();
    await db.close();
  });
  return db;
}

function hour(time: string, counts: Partial<Omit<ActivityHour, "hour">>): ActivityHour {
  return {
    hour: new Date(time).toISOString(),
    turns: 0,
    busyMs: 0,
    aiCredits: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...counts,
  };
}

const at = (time: string) => new Date(time);

test("recorded activity accumulates per session hour and lists [from, to) by hour then session", async () => {
  await useTestDatabase();
  await recordSessionActivity("b", [hour("2026-11-12T10:00:00Z", { turns: 1 })]);
  await recordSessionActivity("a", [
    hour("2026-11-12T10:00:00Z", { turns: 1, busyMs: 500, aiCredits: 0.25 }),
    hour("2026-11-12T11:00:00Z", { inputTokens: 10, outputTokens: 2 }),
  ]);
  await recordSessionActivity("a", [
    hour("2026-11-12T10:00:00Z", { busyMs: 250, aiCredits: 0.5, cacheReadTokens: 8 }),
  ]);
  await recordSessionActivity("a", [hour("2026-11-12T12:00:00Z", { turns: 1 })]);
  await recordSessionActivity("other", [hour("2026-11-12T10:00:00Z", { turns: 1 })]);

  expect(
    await listSessionActivity(["b", "a"], at("2026-11-12T10:00:00Z"), at("2026-11-12T12:00:00Z")),
  ).toEqual([
    {
      sessionId: "a",
      ...hour("2026-11-12T10:00:00Z", {
        turns: 1,
        busyMs: 750,
        aiCredits: 0.75,
        cacheReadTokens: 8,
      }),
    },
    { sessionId: "b", ...hour("2026-11-12T10:00:00Z", { turns: 1 }) },
    { sessionId: "a", ...hour("2026-11-12T11:00:00Z", { inputTokens: 10, outputTokens: 2 }) },
  ]);
  expect(
    await listSessionActivity([], at("2026-11-12T00:00:00Z"), at("2026-11-13T00:00:00Z")),
  ).toEqual([]);
});

test("a backfill replaces the hours its history covers, so rerunning it is safe", async () => {
  const db = await useTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), "agent-teams-activity-backfill-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  const line = (type: string, timestamp: string, data: object = {}) =>
    JSON.stringify({ type, timestamp, data });
  await Bun.write(
    path,
    [
      line("user.message", "2026-11-12T10:50:00.000Z", { content: "go" }),
      line("assistant.turn_start", "2026-11-12T10:50:00.000Z", { turnId: "0" }),
      line("session.usage_record", "2026-11-12T11:05:00.000Z", {
        usage: {
          model: "test",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 90,
          cacheWriteTokens: 4,
          copilotUsage: { totalNanoAiu: 1.5e9 },
          accounting: { sourceSessionId: "root", sequence: 1, usageId: "1" },
        },
      }),
      line("assistant.turn_end", "2026-11-12T11:10:00.000Z", { turnId: "0" }),
      line("session.usage_checkpoint", "2026-11-12T11:10:01.000Z", {
        totalNanoAiu: 1.5e9,
        usageAccountingWatermarks: { root: 1 },
      }),
    ].join("\n"),
  );
  const outside = hour("2026-11-12T13:00:00Z", { turns: 1, busyMs: 1_000 });
  await recordSessionActivity("session", [
    hour("2026-11-12T11:00:00Z", { turns: 4, aiCredits: 9 }),
    outside,
  ]);

  const expected = [
    hour("2026-11-12T10:00:00Z", { turns: 1, busyMs: 10 * 60_000 }),
    hour("2026-11-12T11:00:00Z", {
      busyMs: 10 * 60_000,
      aiCredits: 1.5,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 90,
      cacheWriteTokens: 4,
    }),
  ];
  expect(await backfillSessionActivity("session", readCopilotActivity(path))).toEqual(expected);
  expect(await backfillSessionActivity("session", readCopilotActivity(path), db)).toEqual(expected);
  expect(
    await listSessionActivity(["session"], at("2026-11-12T00:00:00Z"), at("2026-11-13T00:00:00Z")),
  ).toEqual([...expected, outside].map((activity) => ({ sessionId: "session", ...activity })));
});
