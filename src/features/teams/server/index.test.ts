import { getTeamSnapshot } from "./stream";
import { teamAgent, createStoredTeam } from "@teams/server/testFixtures";
import { beforeEach, expect, mock, onTestFinished, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamAgentMetadataSchema, type TeamEvent } from "@teams/model";
import { machineFile, sessionFile, workspaceFileId } from "@files/model";
import { reduceTeamState } from "@teams/model/reducer";
import { createTestDatabase } from "@/server/database";
import { detachManagedSession } from "@/server/managedSessions";
import * as sessions from "@sessions/server/providers";
import * as sessionRuntime from "@sessions/server/runtime";
import { normalizeToolResult, type Tool } from "@sessions/server/tools/definition";
import * as workspaceEvents from "@workspace/server/events";
import { setSessionStatus } from "@workspace/server/state";
import { deleteSessionState } from "@workspace/server/state/sessions";
import startTeams from "./startup";
import { getTeamAgentConfiguration } from "./agent";

let currentDb: Bun.SQL | undefined;

mock.module("@/server/database", () => ({
  getStateDatabase: async () => {
    if (!currentDb) throw new Error("Test database has not been opened");
    return currentDb;
  },
}));

const { TeamDatabase } = await import("./database");
const {
  createTeam,
  getTeamUsage,
  deleteTeam,
  createTeamMember,
  createTeamMembersFromLead,
  editTeam,
  editTeamTasksFromLead,
  finishTeamAgentTurn,
  markTeamRead,
  postTeamMessageFromSession,
  readTeamForAgent,
  readTeamForSession,
  readTeamThreadForAgent,
  runTeamRoutine,
  sendTeamMessageFromAgent,
  setTeamAgentStatus,
  setTeamMessageReactionFromAgent,
  setTeamRoutineFromLead,
  updateTeamMember,
  updateTeamFromLead,
  wakeDueTeamAgents,
} = await import("./index");
const { subscribeTeamEvents, releaseTeamEvents } = await import("./events");
const { teamLeadTools, teamMemberTools, teamTools, createTeamMembersTool } =
  await import("./tools");

beforeEach(() => {
  const create = spyOn(sessionRuntime, "createSession").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => create.mockRestore());
});

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const TEAM_DEFAULTS = {
  purpose: "Coordinate the work to a useful result.",
  model: { provider: "copilot", name: "gpt-5.5" },
} as const;

async function openTeams() {
  const database = await createTestDatabase();
  currentDb = database;
  onTestFinished(async () => {
    await database.close();
    currentDb = undefined;
  });
  return new TeamDatabase(database);
}

async function invokeTool(name: string, input = {}, sessionId = "coordinator") {
  const tool = [...teamTools, createTeamMembersTool, ...teamMemberTools, ...teamLeadTools].find(
    (tool) => tool.name === name,
  ) as Tool | undefined;
  if (!tool) throw new Error(`Tool not found: ${name}`);
  const result = normalizeToolResult(
    await tool.handler(tool.parameters?.parse(input) ?? input, {
      sessionId,
      toolCallId: name,
      toolName: name,
      arguments: input,
    }),
  );
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected a text tool result.");
  return JSON.parse(content.text);
}

test("team usage reads only the current roster's session metadata, including the lead", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Usage", ...TEAM_DEFAULTS });
  await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const usage = spyOn(sessionRuntime, "getSessionUsage").mockImplementation(async (id) =>
    id === team.id ? { aiCredits: 1.25, status: "complete" } : undefined,
  );
  onTestFinished(() => usage.mockRestore());
  expect(await getTeamUsage(team.id)).toEqual({
    [team.id]: { aiCredits: 1.25, status: "complete" },
    builder: undefined,
  });
  expect(usage.mock.calls.map(([id]) => id).sort()).toEqual([team.id, "builder"].sort());

  usage.mockRejectedValue(new Error("Native history unavailable"));
  await expect(getTeamUsage(team.id)).rejects.toThrow("Native history unavailable");
  await expect(getTeamUsage("missing")).rejects.toThrow("Team not found.");
});

test("attention uses normal messages and upserts, and a user reply also wakes the lead", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Attention", ...TEAM_DEFAULTS });
  const { member } = await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const events: TeamEvent[] = [];
  const unsubscribe = subscribeTeamEvents(team.id, (event) => events.push(event));
  const broadcasts = spyOn(workspaceEvents, "broadcast").mockImplementation(() => {});
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(async () => {
    unsubscribe();
    releaseTeamEvents(team.id);
    broadcasts.mockRestore();
    deliver.mockRestore();
  });

  await setTeamAgentStatus(team.id, { status: "Finishing" });
  const request = await sendTeamMessageFromAgent(team.id, {
    content: "Choose the next task.",
    request: true,
  });
  await updateTeamFromLead(team.id, {
    tasks: [{ id: "ship", title: "Ship", status: "done" }],
  });
  expect(
    events.filter((event) => event.type === "message").map(({ message }) => message.content),
  ).toEqual([request.content, { type: "tasks_completed" }]);
  expect(broadcasts.mock.calls.map(([event]) => event.type)).toEqual([
    "team.upserted",
    "team.upserted",
  ]);
  expect(broadcasts.mock.lastCall?.[0]).toMatchObject({
    team: { requestSequence: expect.any(Number), completedSequence: expect.any(Number) },
  });
  expect(deliver).not.toHaveBeenCalled();
  expect((await teams.getAgent(team.id))?.status?.state).toBe("working");
  await finishTeamAgentTurn(team.id, "Your color choice");
  await postTeamMessageFromSession("user-session", {
    id: "decision",
    teamId: team.id,
    content: "@builder use blue.",
  });
  expect(deliver.mock.calls.map(([id]) => id).sort()).toEqual([team.id, member.id].sort());
  expect((await teams.getTeam(team.id))?.requestSequence).toBeNull();
  expect((await teams.getAgent(team.id))?.status).toBeUndefined();
});

test("creating a Team starts its lead without creating a directory", async () => {
  await openTeams();
  const root = await mkdtemp(join(tmpdir(), "agent-teams-team-create-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, "nested", "workspace");
  const leadStarted = Promise.withResolvers<Parameters<typeof sessionRuntime.createSession>>();
  const create = spyOn(sessionRuntime, "createSession").mockImplementation(async (...args) => {
    leadStarted.resolve(args);
    return {
      disposition: "started",
      waitForCompletion: async () => ({ status: "completed" }),
    };
  });
  onTestFinished(() => create.mockRestore());

  const team = await createTeam({
    name: "Bitmap studio",
    directory,
    model: TEAM_DEFAULTS.model,
  });
  const [leadId, message, options] = await leadStarted.promise;

  expect(team.directory).toBe(directory);
  expect(team.purpose).toBeUndefined();
  await expect(stat(directory)).rejects.toThrow();
  expect(leadId).toBe(team.id);
  expect(message).toMatchObject({
    content: "This team was just created. Begin working toward its purpose.",
  });
  expect(options).toMatchObject({
    sessionType: "worker",
    name: "Lead · Bitmap studio",
  });
});

test.each([false, true])(
  "team deletion publishes once and attempts all session cleanup (failure=%s)",
  async (failCleanup) => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Delete", ...TEAM_DEFAULTS });
    await teams.createMember(teamAgent(team.id, "builder", "Builder"));
    await teams.createMember(teamAgent(team.id, "reviewer", "Reviewer"));
    const agentIds = await teams.listAgentIds(team.id);
    const observed: unknown[] = [];
    onTestFinished(subscribeTeamEvents(team.id, (event) => observed.push(event)));
    const broadcasts = spyOn(workspaceEvents, "broadcast").mockImplementation((event) => {
      observed.push(event);
    });
    const cleanup = spyOn(sessionRuntime, "deleteSessionIfExists").mockImplementation(
      async (id) => {
        observed.push(id);
        await detachManagedSession(id);
        if (failCleanup && id === "builder") throw new Error("Provider cleanup failed");
        return true;
      },
    );
    onTestFinished(() => {
      cleanup.mockRestore();
      broadcasts.mockRestore();
    });

    const deletion = deleteTeam(team.id);
    if (failCleanup) await expect(deletion).rejects.toThrow("Team deleted; agent cleanup failed.");
    else expect(await deletion).toBe(true);
    expect(await deleteTeam(team.id)).toBe(false);
    expect(await teams.getTeam(team.id)).toBeNull();
    expect(await teams.listAgentIds(team.id)).toEqual([]);
    expect(observed[0]).toEqual({ type: "team.deleted", teamId: team.id });
    expect(observed.slice(1)).toEqual(expect.arrayContaining(agentIds));
    expect(observed).toHaveLength(agentIds.length + 1);
  },
);

test("an addressed post settles after its Agent wake is ready and a duplicate never delivers", async () => {
  const teams = await openTeams();

  const team = await createStoredTeam(teams, {
    name: "Coordination",
    ...TEAM_DEFAULTS,
  });
  const { member } = await teams.createMember(teamAgent(team.id, "reviewer-session", "Reviewer"));
  await teams.setAgentStatus(member.id, { state: "waiting", text: "a review request" });
  let releaseWake!: () => void;
  let announceWake!: () => void;
  const wakeStarted = new Promise<void>((resolve) => {
    announceWake = resolve;
  });
  const wakeFinished = new Promise<void>((resolve) => {
    releaseWake = resolve;
  });
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockImplementation(async () => {
    announceWake();
    await wakeFinished;
    return {
      disposition: "queued",
      waitForCompletion: async () => ({ status: "completed" }),
    };
  });
  onTestFinished(() => deliver.mockRestore());

  let settled = false;
  const input = {
    id: "review-request",
    teamId: team.id,
    content: "@reviewer please inspect this.",
  };
  const post = postTeamMessageFromSession("coordinator-session", input).then(() => {
    settled = true;
  });
  await wakeStarted;
  expect(settled).toBe(false);
  releaseWake();
  await post;
  expect((await teams.getMember(member.id))?.status).toBeUndefined();
  await expect(postTeamMessageFromSession("coordinator-session", input)).rejects.toThrow();
  expect(deliver).toHaveBeenCalledTimes(1);
  expect((await teams.getTeam(team.id))?.latestSequence).toBe(2);
});

test("an Agent can attach image and video files to a durable Team message", async () => {
  const teams = await openTeams();
  const directory = await mkdtemp(join(tmpdir(), "agent-teams-team-message-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const team = await createStoredTeam(teams, {
    name: "Visual review",
    ...TEAM_DEFAULTS,
  });
  const screenshot = join(directory, "screenshot.png");
  const recording = join(directory, "flow.webm");
  await Bun.write(screenshot, Buffer.from(PNG_BASE64, "base64"));
  await Bun.write(recording, "webm");

  const message = await sendTeamMessageFromAgent(team.id, {
    content: "The layout is ready for review.",
    attachmentPaths: [screenshot, recording],
  });

  expect(message).toMatchObject({
    sequence: 1,
    sender: { type: "agent", agentId: team.id },
    content: "The layout is ready for review.",
    attachments: [screenshot, recording],
  });
  expect((await teams.listMessagesAfter(team.id)).at(-1)).toEqual(message);
});

test("agents reply within a thread and read it whole without moving their read position", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Threads", ...TEAM_DEFAULTS });
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => {
    releaseTeamEvents(team.id);
    deliver.mockRestore();
  });

  const question = await postTeamMessageFromSession("coordinator", {
    id: "question",
    teamId: team.id,
    content: "Add dark mode?",
  });
  const reply = await invokeTool(
    "send_team_message",
    { content: "On it.", threadSequence: question.sequence },
    team.id,
  );
  await sendTeamMessageFromAgent(team.id, { content: "The build is green." });
  expect((await readTeamForAgent(team.id)).messages).toMatchObject([
    { sequence: question.sequence },
    { sequence: reply.sequence, threadSequence: question.sequence },
    { content: "The build is green." },
  ]);
  const done = await sendTeamMessageFromAgent(team.id, {
    content: "Done.",
    threadSequence: reply.sequence,
  });

  expect(done.threadSequence).toBe(question.sequence);
  expect(
    (await readTeamThreadForAgent(team.id, done.sequence)).messages.map(({ sequence }) => sequence),
  ).toEqual([question.sequence, reply.sequence, done.sequence]);
  expect((await teams.getAgent(team.id))?.seenThrough).toBe(3);
  expect(
    await invokeTool("read_team", { teamId: team.id, threadSequence: question.sequence }),
  ).toMatchObject({
    messages: [
      { content: "Add dark mode?" },
      { content: "On it." },
      { content: "Done.", threadSequence: question.sequence },
    ],
    hasMore: false,
  });
});

test("joining starts onboarding before any mention; later assignments use normal delivery", async () => {
  currentDb = await createTestDatabase();
  const teams = new TeamDatabase(currentDb);
  const team = await createStoredTeam(teams, { name: "Onboarding", ...TEAM_DEFAULTS });
  const onboarding = Promise.withResolvers<{ status: "completed" }>();
  let admittedAtStart: unknown;
  const create = spyOn(sessionRuntime, "createSession").mockImplementation(async (id) => {
    admittedAtStart = {
      member: await teams.getMember(id),
      announcement: (await teams.listMessagesAfter(team.id)).at(-1)?.content,
    };
    return { disposition: "started", waitForCompletion: () => onboarding.promise };
  });
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "queued",
    waitForCompletion: () => onboarding.promise,
  });
  const { waitForSessions } = sessionRuntime;
  let memberId: string | undefined;
  onTestFinished(async () => {
    onboarding.resolve({ status: "completed" });
    if (memberId) await waitForSessions([memberId]);
    create.mockRestore();
    deliver.mockRestore();
    releaseTeamEvents(team.id);
    await currentDb?.close();
    currentDb = undefined;
  });
  const member = await createTeamMember({ teamId: team.id, name: "Reviewer" });
  memberId = member.id;
  expect(create).toHaveBeenCalledTimes(1);
  expect(create.mock.calls[0]?.[1]).toMatchObject({
    content: expect.stringContaining("complete any missing profile details"),
  });
  expect(deliver).not.toHaveBeenCalled();
  expect((await teams.getMember(member.id))?.status).toBeUndefined();
  await postTeamMessageFromSession("user", {
    id: crypto.randomUUID(),
    teamId: team.id,
    content: "@reviewer inspect the result.",
  });
  expect(deliver.mock.calls[0]?.[0]).toBe(member.id);
  onboarding.resolve({ status: "completed" });
  await expect(waitForSessions([member.id])).resolves.toEqual([{ status: "completed" }]);
  expect(admittedAtStart).toMatchObject({
    member: { id: member.id, name: "Reviewer" },
    announcement: { type: "member_joined", member: { id: member.id } },
  });
  expect(await teams.getMember(member.id)).not.toBeNull();
  await postTeamMessageFromSession("user", {
    id: crypto.randomUUID(),
    teamId: team.id,
    content: "@reviewer check the next result.",
  });
  expect(create).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledTimes(2);
});

test("only the Team lead can create members", async () => {
  const teams = await openTeams();

  const team = await createStoredTeam(teams, {
    name: "Product studio",
    ...TEAM_DEFAULTS,
  });

  const peers = await createTeamMembersFromLead(team.id, [
    {
      name: "Designer",
      role: "Turns product direction into clear interaction design.",
      model: { provider: "copilot", name: "designer-model" },
    },
    {
      name: "Engineer",
      role: "Builds the agreed product direction.",
    },
  ]);

  expect(peers).toMatchObject([
    {
      teamId: team.id,
      name: "Designer",
      role: "Turns product direction into clear interaction design.",
      model: { provider: "copilot", name: "designer-model" },
    },
    {
      teamId: team.id,
      name: "Engineer",
      role: "Builds the agreed product direction.",
    },
  ]);
  expect((await teams.listMembers(team.id)).map(({ name }) => name)).toEqual([
    "Designer",
    "Engineer",
  ]);
  await expect(createTeamMembersFromLead(peers[0]!.id, [{ name: "Researcher" }])).rejects.toThrow(
    "Only the team lead can create members.",
  );
});

test("team tools use agentId across creation, context, profile updates, and waiting", async () => {
  await openTeams();

  const { team } = await invokeTool("create_team", { name: "Identity", ...TEAM_DEFAULTS });
  const teamId = team.teamId;
  onTestFinished(() => releaseTeamEvents(teamId));
  expect(team.lead).toEqual({ agentId: teamId, mention: "@lead" });
  expect((await invokeTool("list_teams")).teams[0].lead).toEqual(team.lead);

  const { members } = await invokeTool("create_team_members", {
    teamId,
    members: [{ name: "Reviewer" }],
  });
  const member = members[0];
  expect(member).toEqual({ agentId: expect.any(String), mention: "@reviewer" });
  const profile = await invokeTool(
    "update_member",
    { role: "Review the outcome." },
    member.agentId,
  );
  expect(profile.agentId).toBe(member.agentId);
  expect(profile).not.toHaveProperty("id");

  // Stored work left behind by an idle session must not appear as active work to peers.
  await setTeamAgentStatus(member.agentId, { status: "Reviewing" });
  const context = await invokeTool("read_team", { teamId });
  expect(context.lead.agentId).toBe(team.lead.agentId);
  expect(context.members).toEqual([
    {
      agentId: member.agentId,
      uri: `team:${teamId}/agents/${member.agentId}`,
      name: "Reviewer",
      mention: "@reviewer",
      role: "Review the outcome.",
    },
  ]);
  expect(context.messages[0].content).toEqual({ type: "member_joined", agentId: member.agentId });
  expect(
    await invokeTool("wait_for_team_agents", {
      teamId,
      agentIds: [context.lead.agentId, context.members[0].agentId],
    }),
  ).toEqual({
    agents: [
      { agentId: teamId, status: "completed" },
      { agentId: member.agentId, status: "completed" },
    ],
  });
});

test("cross-team inspection reads configuration and old threads without execution or cursor effects", async () => {
  const teams = await openTeams();
  const source = await createStoredTeam(teams, { name: "Source", ...TEAM_DEFAULTS });
  const home = await createStoredTeam(teams, { name: "Learners", ...TEAM_DEFAULTS });
  const memberModel = { provider: "codex", name: "gpt-6", reasoningEffort: "high" };
  await teams.createMember({
    ...teamAgent(source.id, "reviewer", "Reviewer"),
    metadata: { seenThrough: 0, role: "Review before release.", model: memberModel },
  });
  const { message: root } = await teams.appendMessage({
    id: "process",
    teamId: source.id,
    sender: { type: "agent", agentId: source.id },
    content: "Review each outcome before releasing it.",
  });
  for (let index = 0; index < 105; index++)
    await teams.appendMessage({
      id: `update-${index}`,
      teamId: source.id,
      sender: { type: "user" },
      content: `Update ${index}`,
    });
  const { message: reply } = await teams.appendMessage({
    id: "lesson",
    teamId: source.id,
    sender: { type: "agent", agentId: "reviewer" },
    content: "Keep acceptance criteria explicit.",
    threadSequence: root.sequence,
  });
  await teams.editTeam({ teamId: source.id, name: "Renamed source", paused: true });
  const before = await teams.getSnapshot(source.id, 200);
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage");
  onTestFinished(() => deliver.mockRestore());
  const uri = `team:${source.id}`;

  const latest = await invokeTool("inspect_team", { uri }, home.id);
  expect(latest.team).toMatchObject({
    teamId: source.id,
    name: "Renamed source",
    uri,
    membersUri: `${uri}/members`,
    paused: true,
    model: source.model,
  });
  expect(latest.messages).toHaveLength(100);
  expect(latest.hasMore).toBe(true);
  expect(latest.members[0]).toMatchObject({
    agentId: "reviewer",
    uri: `${uri}/agents/reviewer`,
    role: "Review before release.",
    model: memberModel,
  });
  expect(latest.lead).toMatchObject({ uri: `${uri}/agents/${source.id}`, model: source.model });
  expect(latest).not.toHaveProperty("sessions");
  for (const suffix of ["/members", "/agents/reviewer", `/agents/${source.id}`])
    expect(
      (await invokeTool("inspect_team", { uri: `${uri}${suffix}` }, home.id)).team.teamId,
    ).toBe(source.id);

  const thread = await invokeTool(
    "inspect_team",
    { uri: `${uri}/messages/${reply.sequence}` },
    home.id,
  );
  expect(thread.messages.map(({ sequence }: { sequence: number }) => sequence)).toEqual([
    root.sequence,
    reply.sequence,
  ]);
  expect(thread.messages[0].uri).toBe(`${uri}/messages/${root.sequence}`);
  expect(thread.hasMore).toBe(false);
  const older = await invokeTool(
    "inspect_team",
    { uri, beforeSequence: latest.messages[0].sequence },
    home.id,
  );
  expect(older.messages.some(({ content }: { content: string }) => content === root.content)).toBe(
    true,
  );
  expect(older.hasMore).toBe(false);
  expect(await teams.getSnapshot(source.id, 200)).toEqual(before);
  const { getPersistedWorker } = await import("@workers/server/database");
  for (const id of [source.id, "reviewer", home.id])
    expect(
      teamAgentMetadataSchema.parse((await getPersistedWorker(id))?.metadata).seenThrough,
    ).toBe(0);
  expect(deliver).not.toHaveBeenCalled();
  expect(sessionRuntime.createSession).not.toHaveBeenCalled();

  const { getTeamThreadSequence } = await import("./index");
  expect(await getTeamThreadSequence(source.id, reply.sequence)).toBe(root.sequence);
  await expect(
    invokeTool("inspect_team", { uri: `${uri}/agents/deleted` }, home.id),
  ).rejects.toThrow("Team agent not found.");
  await expect(
    invokeTool("inspect_team", { uri: `${uri}/messages/9999` }, home.id),
  ).rejects.toThrow();
  await expect(invokeTool("inspect_team", { uri: "team:deleted" }, home.id)).rejects.toThrow(
    "Team not found.",
  );
});

test("a Session can seed and passively read Team context", async () => {
  const getDirectory = spyOn(sessions, "getSessionDirectory").mockResolvedValue(undefined);
  onTestFinished(() => getDirectory.mockRestore());
  const teams = await openTeams();
  const directory = await mkdtemp(join(tmpdir(), "agent-teams-team-session-"));
  onTestFinished(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const team = await createStoredTeam(teams, {
    name: "Research",
    directory,
    ...TEAM_DEFAULTS,
  });
  await Promise.all([
    Bun.write(join(directory, "evidence.png"), Buffer.from(PNG_BASE64, "base64")),
    Bun.write(join(directory, "brief.md"), "# Brief"),
  ]);
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => deliver.mockRestore());

  const message = await postTeamMessageFromSession("coordinator-session", {
    id: "kickoff",
    teamId: team.id,
    content: "Review the evidence and brief.",
    attachmentPaths: [join(directory, "evidence.png")],
  });
  const artifact = await invokeTool(
    "share_team_artifact",
    { teamId: team.id, path: "brief.md", title: "Research brief" },
    "coordinator-session",
  );
  await updateTeamFromLead(team.id, {
    purpose: "Turn the evidence into a useful recommendation.",
    tasks: [{ id: "synthesize", title: "Synthesize the evidence", status: "in_progress" }],
    preview: { kind: "url", url: "http://127.0.0.1:3000" },
  });
  const outcome = { artifactId: artifact.artifactId, diff: { added: 32, removed: 8 } };
  expect(
    await invokeTool(
      "edit_team_tasks",
      { operations: [{ type: "update", taskId: "synthesize", patch: outcome }] },
      team.id,
    ),
  ).toEqual({ taskIds: ["synthesize"] });

  const result = await invokeTool("read_team", { teamId: team.id });
  expect(result).toMatchObject({
    team: {
      purpose: "Turn the evidence into a useful recommendation.",
      tasks: [
        { id: "synthesize", title: "Synthesize the evidence", status: "in_progress", ...outcome },
      ],
      preview: { kind: "url", url: "http://127.0.0.1:3000" },
    },
    members: [],
    messages: expect.arrayContaining([
      expect.objectContaining({
        sequence: message.sequence,
        sender: { type: "user" },
        attachments: [join(directory, "evidence.png")],
      }),
      expect.objectContaining({
        content: { type: "artifact_shared", actor: { type: "user" }, artifact },
      }),
    ]),
    artifacts: [
      {
        artifactId: workspaceFileId(machineFile(join(directory, "brief.md"))),
        path: join(directory, "brief.md"),
        title: "Research brief",
      },
    ],
    hasMore: false,
  });
  expect(result.artifacts).toEqual([artifact]);
  expect((await teams.getTeam(team.id))?.seenThrough).toBe(0);
  expect(deliver).toHaveBeenCalledWith(team.id, {
    systemMessage: { type: "team_message", senderName: "the user" },
    immediate: true,
  });
  expect(await readTeamForSession(team.id, message.sequence + 1)).toMatchObject({
    messages: [{ id: "kickoff" }],
    hasMore: false,
  });
});

test("canvas selection reaches observers and agent context through the existing team protocol", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Canvas", ...TEAM_DEFAULTS });
  const file = sessionFile(team.id, "board.toy");
  await teams.shareArtifact({
    teamId: team.id,
    file,
    title: "Work board",
    actor: { type: "agent", agentId: team.id },
  });
  const initial = (await getTeamSnapshot(team.id))!;
  const events: TeamEvent[] = [];
  onTestFinished(subscribeTeamEvents(team.id, (event) => events.push(event)));
  onTestFinished(() => releaseTeamEvents(team.id));
  const canvasArtifactId = workspaceFileId(file);

  const result = await invokeTool("update_team", { canvasArtifactId }, team.id);
  expect(result).toMatchObject({ teamId: team.id, canvasArtifactId });
  expect(events).toMatchObject([
    { type: "message", message: { content: { type: "canvas_changed", canvasArtifactId } } },
  ]);
  expect(events.reduce(reduceTeamState, initial)).toEqual((await getTeamSnapshot(team.id))!);
  const context = await invokeTool("read_team", { teamId: team.id });
  expect(context.team).toMatchObject({ teamId: team.id, canvasArtifactId });
  expect(context.artifacts[0]).toMatchObject({ artifactId: canvasArtifactId, title: "Work board" });

  await invokeTool("update_team", { canvasArtifactId: null }, team.id);
  expect(events.reduce(reduceTeamState, initial)).toEqual((await getTeamSnapshot(team.id))!);
  expect((await teams.getTeam(team.id))?.canvasArtifactId).toBeUndefined();
});

test("committed edits and reads replay to the durable view and only a new purpose wakes the lead", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Planning", ...TEAM_DEFAULTS });
  const initial = (await getTeamSnapshot(team.id))!;
  const teamEvents: TeamEvent[] = [];
  const workspaceUpdates: string[] = [];
  onTestFinished(subscribeTeamEvents(team.id, (event) => teamEvents.push(event)));
  onTestFinished(() => releaseTeamEvents(team.id));
  onTestFinished(
    workspaceEvents.subscribeWorkspaceEvents((event) => {
      if (event.type === "team.upserted" && event.team.id === team.id) {
        workspaceUpdates.push(event.team.name);
      }
    }),
  );

  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => deliver.mockRestore());

  await editTeam({
    teamId: team.id,
    name: "Shipping",
    purpose: "Ship the result.",
  });
  expect(teamEvents.map(({ type, revision }) => [type, revision])).toEqual([
    ["message", 1],
    ["message", 2],
  ]);
  expect(workspaceUpdates).toEqual(["Shipping"]);
  expect(teamEvents[0]).toMatchObject({ message: { content: { actor: { type: "user" } } } });
  expect(deliver).toHaveBeenCalledWith(team.id, {
    systemMessage: { type: "team_message", senderName: "the user" },
    immediate: true,
  });
  expect(deliver).toHaveBeenCalledTimes(1);

  await editTeam({ teamId: team.id, name: "Shipping", purpose: "Ship the result." });
  expect(teamEvents).toHaveLength(2);
  expect(workspaceUpdates).toEqual(["Shipping"]);
  await editTeam({ teamId: team.id, name: "Shipped" });
  expect(teamEvents).toHaveLength(3);
  expect(workspaceUpdates).toEqual(["Shipping", "Shipped"]);

  const beforeTasks = (await teams.getTeam(team.id))!;
  const tasks = [
    { id: "verify", title: "Verify", status: "pending", diff: { added: 3, removed: 1 } },
  ] as const;
  await editTeamTasksFromLead(team.id, {
    operations: [{ type: "add", task: tasks[0] }],
  });
  expect(await teams.getTeam(team.id)).toMatchObject({
    latestSequence: beforeTasks.latestSequence,
    updatedAt: beforeTasks.updatedAt,
  });
  await updateTeamFromLead(team.id, {
    preview: { kind: "url", url: "http://localhost:3000" },
  });
  const model = { provider: "copilot", name: "gpt-6" };
  await editTeam({ teamId: team.id, model });
  await markTeamRead(team.id, 100);
  await markTeamRead(team.id, 1);
  await updateTeamFromLead(team.id, {
    tasks: [...tasks],
    preview: { kind: "url", url: "http://localhost:3000" },
  });
  await editTeam({ teamId: team.id, model });
  expect(teamEvents.slice(3).map(({ type, revision }) => [type, revision])).toEqual([
    ["tasks", 4],
    ["message", 5],
    ["model", 6],
    ["read", 7],
  ]);
  expect(teamEvents.at(-1)).toEqual({
    type: "read",
    revision: 7,
    seenThrough: 4,
  });
  const projected = teamEvents.reduce(reduceTeamState, initial);
  expect(projected).toEqual((await getTeamSnapshot(team.id))!);
  expect(deliver).toHaveBeenCalledTimes(1);
});

test("a lead directory assignment only saves metadata and publishes real changes", async () => {
  const teams = await openTeams();
  const root = await mkdtemp(join(tmpdir(), "agent-teams-team-directory-"));
  onTestFinished(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const team = await createStoredTeam(teams, { name: "Planning", ...TEAM_DEFAULTS });
  const events: TeamEvent[] = [];
  const updates: string[] = [];
  onTestFinished(subscribeTeamEvents(team.id, (event) => events.push(event)));
  onTestFinished(() => releaseTeamEvents(team.id));
  onTestFinished(
    workspaceEvents.subscribeWorkspaceEvents((event) => {
      if (event.type === "team.upserted" && event.team.id === team.id) {
        updates.push(event.team.directory ?? "");
      }
    }),
  );
  const nextDirectory = join(root, "nested", "workspace");
  expect(await updateTeamFromLead(team.id, { directory: nextDirectory })).toMatchObject({
    directory: nextDirectory,
  });
  await expect(stat(nextDirectory)).rejects.toThrow();
  await updateTeamFromLead(team.id, { directory: nextDirectory });
  expect(await updateTeamFromLead(team.id, { directory: null })).toMatchObject({
    directory: undefined,
  });
  expect(events.map((event) => event.type)).toEqual(["message", "message"]);
  expect(updates).toEqual([nextDirectory, ""]);
});

test("editing member metadata publishes a roster change only when something changed", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Review", ...TEAM_DEFAULTS });
  const { member } = await teams.createMember(teamAgent(team.id, "reviewer-session", "Reviewer"));
  const events: TeamEvent[] = [];
  let rosterChanges = 0;
  onTestFinished(subscribeTeamEvents(team.id, (event) => events.push(event)));
  onTestFinished(() => releaseTeamEvents(team.id));
  onTestFinished(
    workspaceEvents.subscribeWorkspaceEvents((event) => {
      if (event.type === "team.member.upserted" || event.type === "team.member.deleted")
        rosterChanges++;
    }),
  );

  const input = {
    agentId: member.id,
    name: "Revised Reviewer",
    role: "Review the implementation.",
    model: { provider: "copilot", name: "gpt-6" },
  };
  const updated = await updateTeamMember(input);
  await updateTeamMember(input);
  expect(events).toMatchObject([{ type: "member", member: updated }]);
  expect(events).toHaveLength(1);
  expect(rosterChanges).toBe(1);
});

test("a Team Agent publishes focus and settles temporary turn state", async () => {
  const teams = await openTeams();

  const team = await createStoredTeam(teams, {
    name: "Protocol review",
    ...TEAM_DEFAULTS,
  });
  const { member } = await teams.createMember(teamAgent(team.id, "reviewer-session", "Reviewer"));
  const first = await teams.appendMessage({
    id: "message-1",
    teamId: team.id,
    sender: { type: "user" },
    content: "Review the protocol.",
  });
  await setTeamAgentStatus(member.id, {
    status: "Reviewing the protocol",
    lookingAt: first.message.sequence,
  });
  expect(await teams.getMember(member.id)).toMatchObject({
    status: {
      state: "working",
      text: "Reviewing the protocol",
      lookingAt: first.message.sequence,
    },
  });
  await setTeamAgentStatus(member.id, {
    status: "Implementing the revision",
    workingOn: first.message.sequence,
  });
  await setTeamMessageReactionFromAgent(member.id, {
    sequence: first.message.sequence,
    reaction: "love",
  });
  await finishTeamAgentTurn(member.id, "implementation feedback");

  expect(await teams.getMember(member.id)).toMatchObject({
    status: { state: "waiting", text: "implementation feedback" },
  });
  const messages = await teams.listMessagesAfter(team.id);
  expect(messages.find(({ id }) => id === first.message.id)?.reactions).toEqual([
    { agentId: member.id, reaction: "love" },
  ]);
  await setTeamAgentStatus(member.id, { status: "Checking the revision" });
  await finishTeamAgentTurn(member.id);
  expect((await teams.getMember(member.id))?.status).toBeUndefined();
});

test("session completion and startup clear working status, preserving waits and subsequent turns", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Activity", ...TEAM_DEFAULTS });
  const { member } = await teams.createMember(teamAgent(team.id, "active", "Active"));
  const { member: waiting } = await teams.createMember(teamAgent(team.id, "waiting", "Waiting"));
  await setTeamAgentStatus(team.id, { status: "Left over from shutdown" });
  await setTeamAgentStatus(member.id, { status: "Still running" });
  await finishTeamAgentTurn(waiting.id, "CI", 20);
  const wait = (await teams.getAgent(waiting.id))!.status;
  setSessionStatus(member.id, "running");
  onTestFinished(() => {
    deleteSessionState(member.id);
    deleteSessionState(waiting.id);
    deleteSessionState(team.id);
  });
  const events: TeamEvent[] = [];
  onTestFinished(subscribeTeamEvents(team.id, (event) => events.push(event)));
  onTestFinished(await startTeams());
  expect((await teams.getAgent(team.id))?.status).toBeUndefined();
  expect((await teams.getAgent(member.id))?.status?.state).toBe("working");
  expect((await teams.getAgent(waiting.id))?.status).toEqual(wait);

  for (const status of ["idle", "unread"] as const) {
    await setTeamAgentStatus(member.id, { status: "Finishing" });
    const cleared = Promise.withResolvers<void>();
    const unsubscribe = subscribeTeamEvents(team.id, (event) => {
      if (event.type === "status" && event.agentId === member.id && !event.status)
        cleared.resolve();
    });
    setSessionStatus(member.id, status);
    await cleared.promise;
    unsubscribe();
    expect((await teams.getAgent(member.id))?.status).toBeUndefined();
  }
  setSessionStatus(waiting.id, "idle");
  await setTeamAgentStatus(member.id, { status: "Old turn" });
  setSessionStatus(member.id, "idle");
  setSessionStatus(member.id, "running");
  await setTeamAgentStatus(member.id, { status: "New turn" });
  expect((await teams.getAgent(member.id))?.status).toEqual({
    state: "working",
    text: "New turn",
  });
  expect((await teams.getAgent(waiting.id))?.status).toEqual(wait);
  expect(events.every(({ type }) => type === "status")).toBe(true);
});

function spyOnDelivery() {
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  const broadcasts = spyOn(workspaceEvents, "broadcast").mockImplementation(() => {});
  onTestFinished(() => {
    deliver.mockRestore();
    broadcasts.mockRestore();
  });
  return deliver;
}

test("a lead follow-up privately wakes it once when due", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Deploy", ...TEAM_DEFAULTS });
  const deliver = spyOnDelivery();
  setSystemTime(new Date("2026-09-29T15:00:00.000Z"));
  onTestFinished(() => setSystemTime());

  await finishTeamAgentTurn(team.id, "CI to finish", 20);
  expect((await teams.getAgent(team.id))?.status).toEqual({
    state: "waiting",
    text: "CI to finish",
    wakeAt: "2026-09-29T15:20:00.000Z",
  });
  await wakeDueTeamAgents(new Date("2026-09-29T15:19:00.000Z"));
  expect(deliver).not.toHaveBeenCalled();
  await wakeDueTeamAgents(new Date("2026-09-29T15:20:00.000Z"));
  await wakeDueTeamAgents(new Date("2026-09-29T15:21:00.000Z"));

  expect(deliver.mock.calls).toEqual([
    [
      team.id,
      {
        systemMessage: { type: "team_follow_up", waitingFor: "CI to finish" },
        immediate: true,
      },
    ],
  ]);
  expect((await teams.getAgent(team.id))?.status).toBeUndefined();
});

test("a message that wakes the lead first cancels its follow-up", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Deploy", ...TEAM_DEFAULTS });
  const deliver = spyOnDelivery();

  await finishTeamAgentTurn(team.id, "CI to finish", 20);
  await postTeamMessageFromSession("user-session", {
    id: "update",
    teamId: team.id,
    content: "CI passed.",
  });
  await wakeDueTeamAgents(new Date(Date.now() + 30 * 60_000));

  expect(deliver.mock.calls).toEqual([
    [team.id, { systemMessage: { type: "team_message", senderName: "the user" }, immediate: true }],
  ]);
});

test("a due routine privately wakes its lead without adding to the transcript", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Watch", ...TEAM_DEFAULTS });
  const events: TeamEvent[] = [];
  const unsubscribe = subscribeTeamEvents(team.id, (event) => events.push(event));
  onTestFinished(() => {
    unsubscribe();
    releaseTeamEvents(team.id);
  });
  const deliver = spyOnDelivery();

  const routine = await setTeamRoutineFromLead(team.id, {
    title: "CI",
    schedule: "0 * * * *",
    prompt: "Check CI",
  });
  const { latestSequence } = (await teams.getTeam(team.id))!;
  await wakeDueTeamAgents(new Date(Date.now() + 61 * 60_000));

  expect(
    events.filter((event) => event.type === "message").map((event) => event.message.content),
  ).toEqual([{ type: "routine_scheduled", routine }]);
  expect(deliver.mock.calls).toEqual([
    [
      team.id,
      {
        systemMessage: { type: "team_routine", title: "CI", prompt: "Check CI" },
        immediate: true,
      },
    ],
  ]);
  expect((await teams.getTeam(team.id))?.latestSequence).toBe(latestSequence);
});

test("running a routine wakes its lead now and leaves its schedule alone", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Watch", ...TEAM_DEFAULTS });
  const deliver = spyOnDelivery();
  const routine = await setTeamRoutineFromLead(team.id, {
    title: "CI",
    schedule: "0 * * * *",
    prompt: "Check CI",
  });
  const wake: Parameters<typeof sessionRuntime.deliverSessionMessage> = [
    team.id,
    {
      systemMessage: { type: "team_routine", title: "CI", prompt: "Check CI" },
      immediate: true,
    },
  ];

  expect(await runTeamRoutine(team.id, routine.id)).toBe(true);
  await wakeDueTeamAgents(new Date(Date.now() + 61 * 60_000));

  expect(deliver.mock.calls).toEqual([wake, wake]);
});

test("pause stops the entire roster, saves messages without delivery, and resume wakes only the lead", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Pause", ...TEAM_DEFAULTS });
  await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const routine = await setTeamRoutineFromLead(team.id, {
    title: "CI",
    schedule: "0 * * * *",
    prompt: "Check CI",
  });
  const deliver = spyOnDelivery();
  const abort = spyOn(sessionRuntime, "abortSession").mockImplementation(async () => {
    expect((await teams.getTeam(team.id))?.paused).toBe(true);
    return true;
  });
  const events: TeamEvent[] = [];
  onTestFinished(subscribeTeamEvents(team.id, (event) => events.push(event)));
  onTestFinished(() => {
    abort.mockRestore();
    releaseTeamEvents(team.id);
  });

  await editTeam({ teamId: team.id, paused: true });
  expect(abort.mock.calls.map(([id]) => id).sort()).toEqual([team.id, "builder"].sort());
  for (const id of [team.id, "builder"]) {
    await expect(getTeamAgentConfiguration(teamAgent(team.id, id))).rejects.toThrow(
      "team is paused",
    );
  }
  await postTeamMessageFromSession("user", {
    teamId: team.id,
    id: "paused-post",
    content: "@everyone continue later",
  });
  await editTeam({ teamId: team.id, purpose: "Updated while paused" });
  await wakeDueTeamAgents(new Date(Date.now() + 61 * 60_000));
  await expect(runTeamRoutine(team.id, routine.id)).rejects.toThrow("Resume the team");
  await expect(createTeamMember({ teamId: team.id, name: "Late" })).rejects.toThrow(
    "Resume the team",
  );
  expect(deliver).not.toHaveBeenCalled();
  expect((await teams.listMessagesAfter(team.id)).some(({ id }) => id === "paused-post")).toBe(
    true,
  );

  await editTeam({ teamId: team.id, paused: false });
  expect(deliver.mock.calls.map(([id]) => id)).toEqual([team.id]);
  await editTeam({ teamId: team.id, paused: false });
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(
    events.filter((event) => event.type === "message").map(({ message }) => message.content),
  ).toContainEqual({ type: "team_paused", paused: false });
});

test("pause attempts every abort, surfaces failures, and retrying an already paused team stops agents again", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, {
    name: "Stop failures",
    ...TEAM_DEFAULTS,
  });
  await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const abort = spyOn(sessionRuntime, "abortSession").mockImplementation(async (id) => {
    if (id === team.id) throw new Error("Provider abort failed");
    return true;
  });
  onTestFinished(() => {
    abort.mockRestore();
    releaseTeamEvents(team.id);
  });
  await expect(editTeam({ teamId: team.id, paused: true })).rejects.toThrow(
    "some agents could not be stopped",
  );
  expect(abort).toHaveBeenCalledTimes(2);
  expect((await teams.getTeam(team.id))?.paused).toBe(true);
  abort.mockResolvedValue(true);
  await editTeam({ teamId: team.id, paused: true });
  expect(abort).toHaveBeenCalledTimes(4);
});

test("a concurrent resume waits until the previous pause has stopped the agents", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, {
    name: "Concurrent pause",
    ...TEAM_DEFAULTS,
  });
  const stopping = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<boolean>();
  const abort = spyOn(sessionRuntime, "abortSession").mockImplementation(() => {
    stopping.resolve();
    return stopped.promise;
  });
  const deliver = spyOnDelivery();
  onTestFinished(() => {
    stopped.resolve(true);
    abort.mockRestore();
    releaseTeamEvents(team.id);
  });
  const pause = editTeam({ teamId: team.id, paused: true });
  await stopping.promise;
  const resume = editTeam({ teamId: team.id, paused: false });
  expect((await teams.getTeam(team.id))?.paused).toBe(true);
  expect(deliver).not.toHaveBeenCalled();
  stopped.resolve(true);
  await Promise.all([pause, resume]);
  expect((await teams.getTeam(team.id))?.paused).toBe(false);
  expect(deliver.mock.calls.map(([id]) => id)).toEqual([team.id]);
});

test("pause does not wait behind provider startup from a resume", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, {
    name: "Starting resume",
    ...TEAM_DEFAULTS,
  });
  await teams.editTeam({ teamId: team.id, paused: true });
  const starting = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const deliver = spyOnDelivery();
  deliver.mockImplementation(async () => {
    starting.resolve();
    await started.promise;
    return { disposition: "started", waitForCompletion: async () => ({ status: "completed" }) };
  });
  const abort = spyOn(sessionRuntime, "abortSession").mockResolvedValue(true);
  onTestFinished(() => {
    started.resolve();
    abort.mockRestore();
    releaseTeamEvents(team.id);
  });
  const resume = editTeam({ teamId: team.id, paused: false });
  await starting.promise;
  await editTeam({ teamId: team.id, paused: true });
  expect((await teams.getTeam(team.id))?.paused).toBe(true);
  expect(abort).toHaveBeenCalledWith(team.id);
  started.resolve();
  await resume;
});
