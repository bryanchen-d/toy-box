import { expect, onTestFinished, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as state from "@/server/database";
import * as providers from "@providers/server";
import * as nativeSessions from "@sessions/server/providers";
import * as runtime from "@sessions/server/runtime";
import * as settings from "@workspace/server/state/settings";
import { DEFAULT_SETTINGS } from "@workspace/model/config/settings";
import { ADMIN_TEAM_AVATAR, ADMIN_TEAM_ID, ADMIN_TEAM_PURPOSE } from "@teams/model/admin";
import { isTeamSystemMessage } from "@teams/model";
import { readSession, setSessionProvider } from "@sessions/server/state/sessions";
import { createStoredTeam, teamAgent } from "./testFixtures";
import { TeamDatabase } from "./database";
import { ensureAdminTeam, noteStalledSession } from "./admin";
import { adminTeamTools } from "./adminTools";
import { getTeamAgentConfiguration, getTeamAgentTools } from "./agent";
import { wakeTeamAgent } from "./index";
import { deleteWorker } from "@workers/server";

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "agent-teams-admin-"));
  const previousHome = process.env.AGENT_TEAMS_HOME;
  process.env.AGENT_TEAMS_HOME = home;
  const db = await state.createTestDatabase();
  const database = spyOn(state, "getStateDatabase").mockResolvedValue(db);
  const models = spyOn(providers, "listModels").mockResolvedValue([
    { id: "fixture-model", name: "Fixture model", provider: "copilot" },
  ]);
  const preferences = spyOn(settings, "getSettings").mockResolvedValue(DEFAULT_SETTINGS);
  const create = spyOn(nativeSessions, "createSession").mockRejectedValue(
    new Error("Provisioning must not start a provider."),
  );
  onTestFinished(async () => {
    create.mockRestore();
    preferences.mockRestore();
    models.mockRestore();
    database.mockRestore();
    await db.close();
    if (previousHome === undefined) delete process.env.AGENT_TEAMS_HOME;
    else process.env.AGENT_TEAMS_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });
  return { db, teams: new TeamDatabase(db), models, create };
}

test("Admin is provisioned once without execution and repeated startup preserves owner edits", async () => {
  const { teams, create } = await setup();
  const [first, concurrent] = await Promise.all([ensureAdminTeam(), ensureAdminTeam()]);
  expect(first).toEqual(concurrent);
  expect(first).toMatchObject({
    id: ADMIN_TEAM_ID,
    name: "Admin",
    purpose: ADMIN_TEAM_PURPOSE,
    avatar: ADMIN_TEAM_AVATAR,
    latestSequence: 0,
  });
  expect(await readSession(ADMIN_TEAM_ID)).toMatchObject({ id: ADMIN_TEAM_ID });
  expect((await readSession(ADMIN_TEAM_ID))?.provider).toBeUndefined();
  await teams.editTeam({
    teamId: ADMIN_TEAM_ID,
    name: "Operations",
    purpose: "My operations home",
    paused: true,
  });
  const edited = await teams.getTeam(ADMIN_TEAM_ID);
  expect(await ensureAdminTeam()).toEqual(edited);
  expect((await teams.listTeams()).teams).toHaveLength(1);
  expect((await teams.getRoster(ADMIN_TEAM_ID))?.members).toEqual([]);
  expect(create).not.toHaveBeenCalled();
});

test("Admin receives a quiet default avatar when missing and preserves an authored replacement", async () => {
  const { teams, create } = await setup();
  await ensureAdminTeam();
  await teams.updateTeam(ADMIN_TEAM_ID, { avatar: null });
  const before = (await teams.getSnapshot(ADMIN_TEAM_ID, 100))!;
  const initialized = await ensureAdminTeam();
  expect(initialized?.avatar).toEqual(ADMIN_TEAM_AVATAR);
  expect((await teams.getSnapshot(ADMIN_TEAM_ID, 100))?.messages).toEqual(before.messages);
  expect(initialized).toEqual({ ...before.team, avatar: ADMIN_TEAM_AVATAR });
  const authored = { mark: "M5 12h14M12 5v14", color: "#7c3aed" };
  await teams.updateTeam(ADMIN_TEAM_ID, { avatar: authored });
  await teams.editTeam({ teamId: ADMIN_TEAM_ID, paused: true });
  expect((await ensureAdminTeam())?.avatar).toEqual(authored);
  expect((await teams.getTeam(ADMIN_TEAM_ID))?.avatar).toEqual(authored);
  expect(create).not.toHaveBeenCalled();
});

test("provider setup can finish later and an ordinary Admin-named team is never promoted", async () => {
  const { teams, models, create } = await setup();
  models.mockResolvedValueOnce([]);
  expect(await ensureAdminTeam()).toBeNull();
  expect((await teams.listTeams()).teams).toEqual([]);
  const ordinary = await createStoredTeam(teams, {
    name: "Admin",
    model: { provider: "copilot", name: "fixture-model" },
  });
  const builtin = await ensureAdminTeam();
  expect(builtin).toMatchObject({ id: ADMIN_TEAM_ID, name: "Admin 2" });
  expect((await teams.getTeam(ordinary.id))?.name).toBe("Admin");
  expect(create).not.toHaveBeenCalled();
});

test("only the built-in lead receives Admin tools and callers cannot grant themselves authority", async () => {
  const { teams } = await setup();
  await ensureAdminTeam();
  const ordinary = await createStoredTeam(teams, {
    name: "Other",
    model: { provider: "copilot", name: "fixture-model" },
  });
  const member = teamAgent(ADMIN_TEAM_ID, "admin-member", "Assistant");
  await teams.createMember(member);
  for (const worker of [
    teamAgent(ADMIN_TEAM_ID, ADMIN_TEAM_ID),
    member,
    teamAgent(ordinary.id, ordinary.id),
  ]) {
    const names = getTeamAgentTools(worker).map(({ name }) => name);
    expect(names.includes("refresh_session_connection")).toBe(worker.sessionId === ADMIN_TEAM_ID);
    expect(names.includes("check_session_status")).toBe(worker.sessionId === ADMIN_TEAM_ID);
  }
  const refresh = adminTeamTools[1];
  for (const sessionId of [ordinary.id, member.sessionId]) {
    await expect(
      refresh.handler(
        { sessionId: ordinary.id },
        {
          sessionId,
          toolCallId: "attempt",
          toolName: refresh.name,
          arguments: {},
        },
      ),
    ).rejects.toThrow("Only the built-in Admin lead");
  }
  await expect(
    refresh.handler(
      { sessionId: ADMIN_TEAM_ID },
      {
        sessionId: ADMIN_TEAM_ID,
        toolCallId: "self",
        toolName: refresh.name,
        arguments: {},
      },
    ),
  ).rejects.toThrow("invoking session");
  expect(
    await refresh.handler(
      { sessionId: ordinary.id },
      {
        sessionId: ADMIN_TEAM_ID,
        toolCallId: "idle",
        toolName: refresh.name,
        arguments: {},
      },
    ),
  ).toEqual({ state: "disconnected", resumesOnNextMessage: true });
  await expect(
    refresh.handler(
      { sessionId: "missing-session" },
      {
        sessionId: ADMIN_TEAM_ID,
        toolCallId: "missing",
        toolName: refresh.name,
        arguments: {},
      },
    ),
  ).rejects.toThrow("Session not found");
  const configuration = await getTeamAgentConfiguration(teamAgent(ADMIN_TEAM_ID, ADMIN_TEAM_ID));
  expect(configuration.additionalInstructions).toContain("<workspace_administration>");
  await teams.editTeam({ teamId: ADMIN_TEAM_ID, paused: true });
  await expect(
    refresh.handler(
      { sessionId: ordinary.id },
      {
        sessionId: ADMIN_TEAM_ID,
        toolCallId: "paused",
        toolName: refresh.name,
        arguments: {},
      },
    ),
  ).rejects.toThrow("Resume the Admin team");
});

test("Admin and its lead are protected before any deletion or cancellation side effects", async () => {
  const { teams } = await setup();
  await ensureAdminTeam();
  const before = await teams.getSnapshot(ADMIN_TEAM_ID, 100);
  await expect(teams.deleteTeam(ADMIN_TEAM_ID)).rejects.toThrow("cannot be deleted");
  await expect(deleteWorker(ADMIN_TEAM_ID)).rejects.toThrow("cannot be deleted");
  await expect(runtime.deleteSession(ADMIN_TEAM_ID)).rejects.toThrow("cannot be deleted");
  expect(await teams.getSnapshot(ADMIN_TEAM_ID, 100)).toEqual(before);
  expect(await readSession(ADMIN_TEAM_ID)).toBeDefined();
});

test("the first Admin message creates its ordinary worker session, while later messages resume it", async () => {
  await setup();
  await ensureAdminTeam();
  const create = spyOn(runtime, "createSession").mockImplementation(async (id) => {
    await setSessionProvider(id, { id: "copilot" });
    return { disposition: "started", waitForCompletion: async () => ({ status: "completed" }) };
  });
  const deliver = spyOn(runtime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => {
    create.mockRestore();
    deliver.mockRestore();
  });
  const message = { type: "team_message" as const, senderName: "the user" };
  await wakeTeamAgent(ADMIN_TEAM_ID, message);
  await wakeTeamAgent(ADMIN_TEAM_ID, message);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(
    ADMIN_TEAM_ID,
    { systemMessage: message, immediate: true },
    { sessionType: "worker", name: "Lead · Admin" },
  );
  expect(deliver).toHaveBeenCalledTimes(1);
});

function spyOnAdminWakes() {
  const create = spyOn(runtime, "createSession").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => create.mockRestore());
  return create;
}

async function stallNotices(teams: TeamDatabase) {
  return (await teams.listMessagesAfter(ADMIN_TEAM_ID)).flatMap((message) =>
    isTeamSystemMessage(message) && message.content.type === "session_stalled"
      ? [message.content]
      : [],
  );
}

test("a stalled agent is posted to Admin once, naming it and its team, and wakes the Admin lead", async () => {
  const { teams } = await setup();
  await ensureAdminTeam();
  const build = await createStoredTeam(teams, {
    name: "build",
    model: { provider: "copilot", name: "fixture-model" },
  });
  await teams.createMember(teamAgent(build.id, "pipeline-engineer", "Pipeline Engineer"));
  const create = spyOnAdminWakes();
  const stall = {
    sessionId: "pipeline-engineer",
    since: "2026-11-20T14:24:13.825Z",
    queuedMessages: 9,
  };

  await noteStalledSession(stall);
  await noteStalledSession(stall);

  expect(await stallNotices(teams)).toEqual([
    {
      type: "session_stalled",
      sessionId: "pipeline-engineer",
      name: "Pipeline Engineer",
      team: { id: build.id, name: "build" },
      since: "2026-11-20T14:24:13.825Z",
      queuedMessages: 9,
    },
  ]);
  expect(create).toHaveBeenCalledTimes(1);
  expect(create).toHaveBeenCalledWith(
    ADMIN_TEAM_ID,
    { systemMessage: { type: "team_message", senderName: "Agent Teams" }, immediate: true },
    expect.anything(),
  );
});
