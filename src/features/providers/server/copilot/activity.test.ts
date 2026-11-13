import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCopilotActivity } from "./activity";

type NativeLine = {
  type: string;
  timestamp: string;
  data?: Record<string, unknown>;
  agentId?: string;
};

const turnStart = (timestamp: string, agentId?: string): NativeLine => ({
  type: "assistant.turn_start",
  timestamp,
  data: { turnId: "0" },
  ...(agentId ? { agentId } : {}),
});
const turnEnd = (timestamp: string, agentId?: string): NativeLine => ({
  type: "assistant.turn_end",
  timestamp,
  data: { turnId: "0" },
  ...(agentId ? { agentId } : {}),
});
const userMessage = (timestamp: string, source?: string): NativeLine => ({
  type: "user.message",
  timestamp,
  data: { content: "go", ...(source ? { source } : {}) },
});
const receipt = (timestamp: string, sequence: number, nanoAiu: number): NativeLine => ({
  type: "session.usage_record",
  timestamp,
  data: {
    usage: {
      model: "test",
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
      copilotUsage: { totalNanoAiu: nanoAiu },
      accounting: { sourceSessionId: "root", sequence, usageId: `root-${sequence}` },
    },
  },
});

/** Write a native log and read it back as `[ISO time, event summary]` pairs. */
async function read(lines: (NativeLine | string)[]) {
  const directory = await mkdtemp(join(tmpdir(), "agent-teams-copilot-activity-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "events.jsonl");
  await Bun.write(
    path,
    lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n"),
  );
  const events: [string, string][] = [];
  for await (const { at, event } of readCopilotActivity(path)) {
    const summary =
      event.type === "status"
        ? event.status
        : event.type === "usage"
          ? `${event.mode}:${event.usage.aiCredits}`
          : event.type;
    events.push([new Date(at).toISOString(), summary]);
  }
  return events;
}

test("consecutive native turns are one piece of work, and input after a turn ends it", async () => {
  expect(
    await read([
      userMessage("2026-11-12T10:00:00.000Z"),
      turnStart("2026-11-12T10:00:01.000Z"),
      turnEnd("2026-11-12T10:00:05.000Z"),
      turnStart("2026-11-12T10:00:05.001Z"),
      turnEnd("2026-11-12T10:00:09.000Z"),
      userMessage("2026-11-12T10:30:00.000Z"),
      turnStart("2026-11-12T10:30:01.000Z"),
      turnEnd("2026-11-12T10:30:02.000Z"),
    ]),
  ).toEqual([
    ["2026-11-12T10:00:01.000Z", "thinking"],
    ["2026-11-12T10:00:09.000Z", "idle"],
    ["2026-11-12T10:30:01.000Z", "thinking"],
    ["2026-11-12T10:30:02.000Z", "idle"],
  ]);
});

test("subagent turns, input during a turn, and model context never split work", async () => {
  expect(
    await read([
      turnStart("2026-11-12T10:00:00.000Z"),
      turnStart("2026-11-12T10:00:01.000Z", "child"),
      { ...userMessage("2026-11-12T10:00:01.500Z"), agentId: "child" },
      turnEnd("2026-11-12T10:00:02.000Z", "child"),
      userMessage("2026-11-12T10:00:02.500Z"),
      { type: "system.notification", timestamp: "2026-11-12T10:00:03.000Z", data: {} },
      turnEnd("2026-11-12T10:00:04.000Z"),
      userMessage("2026-11-12T10:00:04.001Z", "skill-review"),
      userMessage("2026-11-12T10:00:04.002Z", "system"),
      turnStart("2026-11-12T10:00:04.003Z"),
      turnEnd("2026-11-12T10:00:06.000Z"),
    ]),
  ).toEqual([
    ["2026-11-12T10:00:00.000Z", "thinking"],
    ["2026-11-12T10:00:06.000Z", "idle"],
  ]);
});

test("notifications that resume finished work start new work", async () => {
  expect(
    await read([
      turnStart("2026-11-12T10:00:00.000Z"),
      turnEnd("2026-11-12T10:00:01.000Z"),
      { type: "system.notification", timestamp: "2026-11-12T10:05:00.000Z", data: {} },
      turnStart("2026-11-12T10:05:00.010Z"),
      turnEnd("2026-11-12T10:05:02.000Z"),
    ]),
  ).toEqual([
    ["2026-11-12T10:00:00.000Z", "thinking"],
    ["2026-11-12T10:00:01.000Z", "idle"],
    ["2026-11-12T10:05:00.010Z", "thinking"],
    ["2026-11-12T10:05:02.000Z", "idle"],
  ]);
});

test("aborts and process boundaries end interrupted work, as does the end of the log", async () => {
  expect(
    await read([
      turnStart("2026-11-12T10:00:00.000Z"),
      { type: "abort", timestamp: "2026-11-12T10:00:03.000Z", data: { reason: "user" } },
      turnStart("2026-11-12T10:01:00.000Z"),
      turnEnd("2026-11-12T10:01:02.000Z"),
      { type: "session.shutdown", timestamp: "2026-11-12T10:09:00.000Z", data: {} },
      { type: "session.resume", timestamp: "2026-11-12T11:00:00.000Z", data: {} },
      turnStart("2026-11-12T11:00:01.000Z"),
      { type: "hook.start", timestamp: "2026-11-12T11:00:04.000Z", data: {} },
    ]),
  ).toEqual([
    ["2026-11-12T10:00:00.000Z", "thinking"],
    ["2026-11-12T10:00:03.000Z", "idle"],
    ["2026-11-12T10:01:00.000Z", "thinking"],
    ["2026-11-12T10:01:02.000Z", "idle"],
    ["2026-11-12T11:00:01.000Z", "thinking"],
    ["2026-11-12T11:00:01.000Z", "idle"],
  ]);
});

test("receipts and checkpoints keep the projector's watermarks, so duplicates report once", async () => {
  expect(
    await read([
      {
        type: "session.usage_checkpoint",
        timestamp: "2026-11-12T10:00:00.000Z",
        data: { totalNanoAiu: 2e9, usageAccountingWatermarks: { root: 2 } },
      },
      receipt("2026-11-12T10:00:01.000Z", 2, 1e9),
      receipt("2026-11-12T10:00:02.000Z", 3, 0.5e9),
      receipt("2026-11-12T10:00:03.000Z", 3, 0.5e9),
    ]),
  ).toEqual([
    ["2026-11-12T10:00:00.000Z", "total:2"],
    ["2026-11-12T10:00:02.000Z", "delta:0.5"],
  ]);
});

test("transcript content that mentions lifecycle events is never parsed as one", async () => {
  const quoted = JSON.stringify({ type: "assistant.turn_start" });
  expect(
    await read([
      {
        type: "tool.execution_complete",
        timestamp: "2026-11-12T10:00:00.000Z",
        data: { result: { content: quoted } },
      },
      `{"type":"tool.execution_start","data":{"arguments":"not json`,
    ]),
  ).toEqual([]);
});
