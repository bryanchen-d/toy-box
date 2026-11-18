import { expect, onTestFinished, spyOn, test } from "bun:test";
import * as database from "./database";
import * as providers from "@sessions/server/providers";
import * as modelProviders from "@providers/server";
import * as snapshots from "@sessions/server/state/snapshots";
import { insertSession, setSessionProvider } from "@sessions/server/state/sessions";
import { TeamDatabase } from "@teams/server/database";
import { createStoredTeam, teamAgent } from "@teams/server/testFixtures";
import { WorkerDatabase } from "@workers/server/database";
import { sessionStatusInputSchema } from "@sessions/model/protocol";
import { checkSessionStatus } from "./sessionDiagnostics";

async function setup() {
  const db = await database.createTestDatabase();
  const state = spyOn(database, "getStateDatabase").mockResolvedValue(db);
  const forbidden = async () => {
    throw new Error("Diagnostics must not contact a provider or replay history.");
  };
  const effects = [
    spyOn(providers, "createSession").mockImplementation(forbidden),
    spyOn(providers, "resumeSession").mockImplementation(forbidden),
    spyOn(providers, "listSessions").mockImplementation(forbidden),
    spyOn(modelProviders, "listModels").mockImplementation(forbidden),
    spyOn(snapshots, "loadSessionSnapshot").mockImplementation(forbidden),
  ];
  onTestFinished(async () => {
    effects.forEach((effect) => effect.mockRestore());
    state.mockRestore();
    await db.close();
  });
  const teams = new TeamDatabase(db);
  const team = await createStoredTeam(teams, {
    name: "Diagnostic team",
    model: { provider: "copilot", name: "gpt-5.5" },
  });
  const memberId = `diagnostic-member-${crypto.randomUUID()}`;
  await teams.createMember(teamAgent(team.id, memberId, "Designer"));
  const childId = `diagnostic-child-${crypto.randomUUID()}`;
  await new WorkerDatabase(db).create({
    type: "session",
    parentSessionId: memberId,
    sessionId: childId,
    name: "Design helper",
    createdAt: new Date().toISOString(),
    ephemeral: false,
  });
  return { db, teams, team, memberId, childId, effects };
}

test("status details name team agents and retained sub sessions without starting or reading them", async () => {
  const { teams, team, memberId, childId, effects } = await setup();
  await teams.editTeam({ teamId: team.id, paused: true });
  const before = await teams.getSnapshot(team.id, 100);
  expect(await checkSessionStatus({ sessionId: team.id })).toMatchObject({
    sessionId: team.id,
    type: "worker",
    name: "Lead",
    team: { id: team.id, name: team.name, role: "lead", paused: true },
    running: false,
    queuedCount: 0,
    phase: "idle",
    connection: { state: "disconnected" },
  });
  expect(await checkSessionStatus({ sessionId: memberId })).toMatchObject({
    name: "Designer",
    team: { id: team.id, role: "member", paused: true },
  });
  expect(await checkSessionStatus({ sessionId: childId })).toMatchObject({
    type: "worker",
    parentSessionId: memberId,
    phase: "idle",
  });
  expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
  effects.forEach((effect) => expect(effect).not.toHaveBeenCalled());
});

test("overview pages retained local sessions and managed agents, including workers not yet started", async () => {
  const { team, memberId, childId, effects } = await setup();
  const draftId = `diagnostic-draft-${crypto.randomUUID()}`;
  await insertSession({ id: draftId, createdAt: new Date() });
  await setSessionProvider(draftId, { id: "codex" });
  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await checkSessionStatus({ limit: 2, offset });
    if (!page.sessions) throw new Error("Expected an overview.");
    expect(page.sessions.length).toBeLessThanOrEqual(2);
    ids.push(...page.sessions.map(({ sessionId }) => sessionId));
    if (!page.hasMore) break;
    offset += page.sessions.length;
  }
  for (const id of [team.id, memberId, childId, draftId]) expect(ids).toContain(id);
  expect(new Set(ids).size).toBe(ids.length);
  effects.forEach((effect) => expect(effect).not.toHaveBeenCalled());
});

test("missing status targets and ambiguous or unbounded queries fail explicitly", async () => {
  await setup();
  await expect(checkSessionStatus({ sessionId: `missing-${crypto.randomUUID()}` })).rejects.toThrow(
    "Session not found",
  );
  for (const input of [
    { sessionId: "" },
    { limit: 0 },
    { limit: 101 },
    { offset: -1 },
    { sessionId: "team", limit: 1 },
    { sessionId: "team", offset: 0 },
  ])
    expect(sessionStatusInputSchema.safeParse(input).success).toBe(false);
  expect(sessionStatusInputSchema.parse({})).toEqual({});
});
