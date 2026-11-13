import { expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { createStoredTeam, teamAgent } from "@teams/server/testFixtures";
import { createTestDatabase } from "@/server/database";
import * as sessionRuntime from "@sessions/server/runtime";
import * as workspaceEvents from "@workspace/server/events";
import type { TeamEvent } from "@teams/model";

let currentDb: Bun.SQL | undefined;

mock.module("@/server/database", () => ({
  getStateDatabase: async () => {
    if (!currentDb) throw new Error("Test database has not been opened");
    return currentDb;
  },
}));

const { TeamDatabase } = await import("./database");
const { proposeTeamAdviceFromAgent, resolveTeamAdvice } = await import("./advice");
const { deleteTeam } = await import("./index");
const { subscribeTeamEvents, releaseTeamEvents } = await import("./events");

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
  const { member: auditor } = await teams.createMember(teamAgent(build.id, "auditor", "Auditor"));
  const { member: comms } = await teams.createMember(teamAgent(build.id, "comms", "Comms"));
  spyOn(workspaceEvents, "broadcast").mockImplementation(() => {});
  const wakes = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  spyOn(sessionRuntime, "createSession").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => mock.restore());
  const events: TeamEvent[] = [];
  const unsubscribe = subscribeTeamEvents(build.id, (event) => events.push(event));
  onTestFinished(() => {
    unsubscribe();
    releaseTeamEvents(build.id);
  });
  return { teams, build, auditor, comms, wakes, events };
}

const messageLead = {
  title: "Batch PR syncs",
  finding: "Five PR syncs an hour woke the lead 42 times today (see #4888).",
  action: { type: "message_lead", content: "Merge the five PR syncs into one routine." },
} as const;

test("an agent's advice reaches the panel, and applying it tells the lead as the user, once", async () => {
  const { teams, build, wakes, events } = await open();
  const advice = await proposeTeamAdviceFromAgent("auditor", messageLead);
  expect(advice).toMatchObject({ authorId: "auditor", status: "open" });
  expect(events.filter(({ type }) => type === "advice")).toHaveLength(1);
  expect((await teams.getSnapshot(build.id, 100))?.advice).toEqual([advice]);
  expect(wakes).not.toHaveBeenCalled();

  const applied = await resolveTeamAdvice({
    teamId: build.id,
    adviceId: advice.id,
    resolution: "apply",
  });
  expect(applied).toMatchObject({ status: "applied", resolvedAt: expect.any(String) });
  expect((await teams.listMessagesAfter(build.id)).at(-1)).toMatchObject({
    sender: { type: "user" },
    content:
      '@lead Please apply this advice, "Batch PR syncs": Merge the five PR syncs into one routine.',
  });
  expect(wakes.mock.calls.map(([agentId]) => agentId)).toEqual([build.id]);
  await expect(
    resolveTeamAdvice({ teamId: build.id, adviceId: advice.id, resolution: "apply" }),
  ).rejects.toThrow("already resolved");
  expect(wakes).toHaveBeenCalledTimes(1);
});

test("dismissing advice resolves it without acting", async () => {
  const { teams, build, wakes } = await open();
  const advice = await proposeTeamAdviceFromAgent("auditor", messageLead);
  await resolveTeamAdvice({ teamId: build.id, adviceId: advice.id, resolution: "dismiss" });
  expect((await teams.getAdvice(build.id, advice.id))?.status).toBe("dismissed");
  expect(wakes).not.toHaveBeenCalled();
});

test("applying a move takes members, with their sessions, to a new team led by its own lead", async () => {
  const { teams, build } = await open();
  await teams.setRoutine(build.id, {
    title: "Sweep",
    schedule: "25 * * * *",
    prompt: "Sweep #build",
    agentId: "comms",
  });
  await teams.editTasks(build.id, {
    operations: [
      {
        type: "add",
        task: { id: "t1", title: "Post replies", status: "pending", ownerId: "comms" },
      },
    ],
  });
  const advice = await proposeTeamAdviceFromAgent("auditor", {
    title: "Give Slack its own team",
    finding: "Slack relays are 30% of the lead's wakes.",
    action: { type: "move_members", agentIds: ["comms"], to: { newTeam: { name: "Comms" } } },
  });
  await resolveTeamAdvice({ teamId: build.id, adviceId: advice.id, resolution: "apply" });

  const comms = await teams.getAgent("comms");
  const target = (await teams.listTeams()).teams.find(({ name }) => name === "Comms")!;
  expect(comms).toMatchObject({ teamId: target.id, isLead: false });
  expect((await teams.listMembers(build.id)).map(({ id }) => id)).toEqual(["auditor"]);
  expect(await teams.listRoutines(build.id)).toEqual([]);
  expect((await teams.getTeam(build.id))?.tasks).toEqual([
    { id: "t1", title: "Post replies", status: "pending" },
  ]);
  expect((await teams.listMessagesAfter(target.id)).map(({ content }) => content)).toEqual([
    { type: "member_joined", member: expect.objectContaining({ id: "comms", teamId: target.id }) },
  ]);
});

test("advice whose action can no longer happen is refused, or reopens when applying fails", async () => {
  const { teams, build } = await open();
  await expect(
    proposeTeamAdviceFromAgent("auditor", {
      ...messageLead,
      action: { type: "move_members", agentIds: [build.id], to: { newTeam: { name: "Solo" } } },
    }),
  ).rejects.toThrow("never its lead");

  const ops = await createStoredTeam(teams, { name: "Ops", model: MODEL });
  const advice = await proposeTeamAdviceFromAgent("auditor", {
    ...messageLead,
    action: { type: "move_members", agentIds: ["comms"], to: { teamId: ops.id } },
  });
  await deleteTeam(ops.id);
  await expect(
    resolveTeamAdvice({ teamId: build.id, adviceId: advice.id, resolution: "apply" }),
  ).rejects.toThrow("The target team is gone.");
  expect((await teams.getAdvice(build.id, advice.id))?.status).toBe("open");
  expect((await teams.getAgent("comms"))?.teamId).toBe(build.id);
});
