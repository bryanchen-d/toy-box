import { expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { createStoredTeam, teamAgent } from "@teams/server/testFixtures";
import { createTestDatabase } from "@/server/database";
import * as sessionRuntime from "@sessions/server/runtime";
import * as workspaceEvents from "@workspace/server/events";
import { normalizeToolResult, type Tool } from "@sessions/server/tools/definition";

let currentDb: Bun.SQL | undefined;

mock.module("@/server/database", () => ({
  getStateDatabase: async () => {
    if (!currentDb) throw new Error("Test database has not been opened");
    return currentDb;
  },
}));

const { TeamDatabase } = await import("./database");
const { postTeamMessage, sendTeamMessageFromAgent } = await import("./index");
const { teamTools } = await import("./tools");

const MODEL = { provider: "copilot", name: "gpt-5.5" } as const;

async function open() {
  const db = await createTestDatabase();
  currentDb = db;
  onTestFinished(async () => {
    await db.close();
    currentDb = undefined;
  });
  const teams = new TeamDatabase(db);
  const build = await createStoredTeam(teams, { name: "Build", model: MODEL });
  const health = await createStoredTeam(teams, { name: "Health", model: MODEL });
  spyOn(workspaceEvents, "broadcast").mockImplementation(() => {});
  const wakes = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => mock.restore());
  return { teams, build, health, wakes };
}

function woken(wakes: { mock: { calls: unknown[][] } }) {
  return wakes.mock.calls.map(([agentId, message]) => [
    agentId,
    (message as { systemMessage: { senderName: string } }).systemMessage.senderName,
  ]);
}

test("the user reaches another team's lead, and each side's replies stay in one linked thread", async () => {
  const { teams, build, health, wakes } = await open();
  const root = await postTeamMessage({
    id: "ask",
    teamId: build.id,
    content: "@health please check the 727 shadow run",
  });
  const [received] = await teams.listMessagesAfter(health.id);
  expect(received).toMatchObject({
    id: `ask:${health.id}`,
    sender: { type: "team", teamId: build.id, by: "user" },
    content: "@health please check the 727 shadow run",
  });
  expect(received?.threadSequence).toBeUndefined();
  // Addressing only another team names no agent here, so only that team's lead wakes.
  expect(woken(wakes)).toEqual([[health.id, "the user, from Build"]]);

  wakes.mockClear();
  await sendTeamMessageFromAgent(health.id, {
    content: "@build it's green after the rerun",
    threadSequence: received!.sequence,
  });
  const [, answer] = await teams.listMessagesAfter(build.id);
  expect(answer).toMatchObject({
    sender: { type: "team", teamId: health.id, by: "lead" },
    threadSequence: root.sequence,
  });
  expect(woken(wakes)).toEqual([[build.id, "Health's lead"]]);

  await sendTeamMessageFromAgent(build.id, {
    content: "@health thanks, closing it",
    threadSequence: root.sequence,
  });
  expect((await teams.listMessagesAfter(health.id)).at(-1)).toMatchObject({
    sender: { type: "team", teamId: build.id, by: "lead" },
    threadSequence: received!.sequence,
  });
});

test("another team's message wakes only the receiving lead, even when it names that team's members", async () => {
  const { teams, build, health, wakes } = await open();
  await teams.createMember(teamAgent(health.id, "watcher", "Watcher"));
  await postTeamMessage({ id: "ask", teamId: build.id, content: "@health @watcher rerun 727" });
  expect(wakes.mock.calls.map(([agentId]) => agentId)).toEqual([health.id]);
});

test("a team message reads as its author's words, with how to answer it", async () => {
  const { build, health } = await open();
  await postTeamMessage({ id: "ask", teamId: build.id, content: "@health check 727" });
  const tool = teamTools.find(({ name }) => name === "read_team") as Tool;
  const result = normalizeToolResult(
    await tool.handler(tool.parameters!.parse({ teamId: health.id }), {
      sessionId: "reader",
      toolCallId: "read",
      toolName: "read_team",
      arguments: { teamId: health.id },
    }),
  );
  const [content] = result.content;
  if (content?.type !== "text") throw new Error("Expected a text tool result.");
  expect(JSON.parse(content.text).messages[0].from).toBe(
    'the user, in team "Build". Reply in this thread opening with @build to answer there',
  );
});

test("only a lead can message another team, within its hourly fuse", async () => {
  const { teams, build, health } = await open();
  await teams.createMember(teamAgent(build.id, "builder", "Builder"));
  await expect(
    sendTeamMessageFromAgent("builder", { content: "@health can you rerun 727?" }),
  ).rejects.toThrow("Only your lead can message another team");
  expect(await teams.listMessagesAfter(health.id)).toEqual([]);

  for (let index = 0; index < 20; index++) {
    await sendTeamMessageFromAgent(build.id, { content: `@health update ${index}` });
  }
  await expect(sendTeamMessageFromAgent(build.id, { content: "@health one more" })).rejects.toThrow(
    "You've sent Health 20 messages in the last hour",
  );
  expect(await teams.listMessagesAfter(health.id)).toHaveLength(20);
});

test("messages from another team never forward again", async () => {
  const { teams, build, health } = await open();
  const ops = await createStoredTeam(teams, { name: "Ops", model: MODEL });
  await postTeamMessage({ id: "ask", teamId: build.id, content: "@health @ops sync on 727" });
  expect(await teams.listMessagesAfter(health.id)).toHaveLength(1);
  expect(await teams.listMessagesAfter(ops.id)).toHaveLength(1);
});

test("each wake records who caused it and whether it started, steered, or queued behind a turn", async () => {
  const { teams, build, health, wakes } = await open();
  await teams.createMember(teamAgent(build.id, "builder", "Builder"));
  wakes.mockResolvedValueOnce({
    disposition: "steered",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  await postTeamMessage({ id: "ask", teamId: build.id, content: "@builder rerun 727" });
  await postTeamMessage({ id: "notify", teamId: build.id, content: "@health heads up" });

  expect(await teams.listWakesSince(build.id, new Date(0).toISOString())).toEqual([
    {
      agentId: "builder",
      at: expect.any(String),
      cause: "message",
      author: "user",
      delivery: "steered",
    },
  ]);
  expect(await teams.listWakesSince(health.id, new Date(0).toISOString())).toEqual([
    {
      agentId: health.id,
      at: expect.any(String),
      cause: "message",
      author: build.id,
      delivery: "started",
    },
  ]);
});
