import { expect, test } from "bun:test";
import { createSdkEventProjector } from "./projector";
import type { CopilotEvent } from "./usage";
import {
  applySessionEvent,
  createInitialSessionState,
  replaySessionHistory,
} from "@sessions/model/reducer";

type UsageData = Extract<CopilotEvent, { type: "session.usage_record" }>["data"]["usage"];
type CheckpointData = Extract<CopilotEvent, { type: "session.usage_checkpoint" }>["data"];
const identity = { id: "event", parentId: null, timestamp: "2026-11-02T20:00:00Z" };

function receipt(
  amount: number | undefined,
  sequence: number,
  sourceSessionId = "root",
  status?: UsageData["aiCreditsStatus"],
): CopilotEvent {
  return {
    type: "session.usage_record",
    data: {
      usage: {
        model: "test",
        accounting: { sourceSessionId, sequence, usageId: `${sourceSessionId}-${sequence}` },
        ...(amount !== undefined ? { copilotUsage: { totalNanoAiu: amount } } : {}),
        ...(status ? { aiCreditsStatus: status } : {}),
      },
    },
  };
}

function checkpoint(total: number, sources: Record<string, number>, complete = true): CopilotEvent {
  const providerModelMetrics: CheckpointData["providerModelMetrics"] = complete
    ? [
        {
          provider: null,
          modelId: "test",
          metrics: {
            aiCreditsStatus: "complete",
            requests: { count: 1, cost: 1 },
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
        },
      ]
    : undefined;
  return {
    ...identity,
    type: "session.usage_checkpoint",
    data: { totalNanoAiu: total, usageAccountingWatermarks: sources, providerModelMetrics },
  };
}

test("durable receipts convert nano-AIU to credits and agree live and after history replay", () => {
  const events = [
    receipt(1_250_000_000, 1),
    receipt(500_000_000, 1, "child"),
    checkpoint(1_750_000_000, { root: 1, child: 1 }),
    receipt(250_000_000, 2),
  ];
  const liveProject = createSdkEventProjector("session");
  const historyProject = createSdkEventProjector("session");
  const live = events.flatMap(liveProject).reduce(applySessionEvent, createInitialSessionState());
  const replayed = replaySessionHistory(events.flatMap(historyProject));
  expect(live.usage).toEqual({ aiCredits: 2, status: "complete" });
  expect(replayed.usage).toEqual(live.usage);
});

test("checkpoint watermarks and duplicate receipts cannot double count main or child calls", () => {
  const project = createSdkEventProjector("session");
  const events = [
    checkpoint(2e9, { root: 4, child: 7 }),
    receipt(1e9, 4),
    receipt(1e9, 7, "child"),
    receipt(0.5e9, 8, "child"),
    receipt(0.5e9, 8, "child"),
  ].flatMap(project);
  expect(replaySessionHistory(events).usage).toEqual({ aiCredits: 2.5, status: "complete" });
});

test("a resumed projector adds new receipts to the session's existing usage", () => {
  const initial = createInitialSessionState({ usage: { aiCredits: 5, status: "complete" } });
  const project = createSdkEventProjector("session");
  const state = project(receipt(0.25e9, 9)).reduce(applySessionEvent, initial);
  expect(state.usage).toEqual({ aiCredits: 5.25, status: "complete" });
});

test("ephemeral usage does not duplicate its durable receipt", () => {
  const project = createSdkEventProjector("session");
  expect(
    project({
      ...identity,
      type: "assistant.usage",
      ephemeral: true,
      data: { model: "test", copilotUsage: { totalNanoAiu: 1e9 } },
    }),
  ).toEqual([]);
  expect(replaySessionHistory(project(receipt(1e9, 1))).usage?.aiCredits).toBe(1);
});

test("missing amounts, partial reports and legacy checkpoints never claim measured zero spend", () => {
  const read = (events: CopilotEvent[]) =>
    replaySessionHistory(events.flatMap(createSdkEventProjector("session"))).usage;
  expect(read([receipt(0, 1)])).toEqual({ aiCredits: 0, status: "complete" });
  expect(read([receipt(undefined, 1)])).toEqual({ aiCredits: 0, status: "unavailable" });
  expect(read([receipt(1e9, 1), receipt(undefined, 2)])).toEqual({
    aiCredits: 1,
    status: "partial",
  });
  expect(read([receipt(1e9, 1, "root", "partial")])?.status).toBe("partial");
  expect(read([checkpoint(1e9, {}, false)])).toEqual({ aiCredits: 1, status: "partial" });
  expect(read([checkpoint(0, {}, false)])?.status).toBe("unavailable");
});

test("shutdown totals replace receipts and child checkpoints cannot replace the parent total", () => {
  const project = createSdkEventProjector("session");
  const child = checkpoint(8e9, {});
  expect(project({ ...child, agentId: "child" })).toEqual([]);
  const state = replaySessionHistory([
    ...project(receipt(1e9, 1)),
    ...project({
      ...identity,
      type: "session.shutdown",
      data: {
        totalNanoAiu: 3e9,
        sessionStartTime: 0,
        shutdownType: "routine",
        totalApiDurationMs: 1,
        modelMetrics: {},
        codeChanges: { filesModified: [], linesAdded: 0, linesRemoved: 0 },
      },
    }),
  ]);
  expect(state.usage).toEqual({ aiCredits: 3, status: "partial" });
});

test("invalid native amounts fail explicitly", () => {
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => createSdkEventProjector("session")(receipt(amount, 1))).toThrow(
      "Copilot reported an invalid AI credit amount.",
    );
  }
});
