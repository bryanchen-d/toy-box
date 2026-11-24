import { getTeamSnapshot } from "./stream";
import { teamAgent, createStoredTeam } from "@teams/server/testFixtures";
import { beforeEach, expect, mock, onTestFinished, setSystemTime, spyOn, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { teamAgentMetadataSchema, teamLead, type TeamEvent } from "@teams/model";
import { machineFile, sessionFile, workspaceFileId } from "@files/model";
import { reduceTeamState } from "@teams/model/reducer";
import { createTestDatabase } from "@/server/database";
import { detachManagedSession } from "@/server/managedSessions";
import * as sessions from "@sessions/server/providers";
import * as sessionRuntime from "@sessions/server/runtime";
import { publishSessionCompletion } from "@sessions/server/runtime/completions";
import { normalizeToolResult, type Tool } from "@sessions/server/tools/definition";
import * as workspaceEvents from "@workspace/server/events";
import { setSessionStatus } from "@workspace/server/state";
import { deleteSessionState } from "@workspace/server/state/sessions";
import startTeams from "./startup";
import { getTeamAgentConfiguration } from "./agent";
import * as providerCatalog from "@providers/server";

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
  detachTeamAgentSession,
  editTeam,
  editTeamTasksFromAgent,
  endTeamAgentTurn,
  finishTeamAgentTurn,
  markTeamRead,
  postTeamMessage,
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

async function invokeTool(
  name: string,
  input = {},
  sessionId = "coordinator",
  tools: readonly unknown[] = [
    ...teamTools,
    createTeamMembersTool,
    ...teamMemberTools,
    ...teamLeadTools,
  ],
) {
  const tool = (tools as Tool[]).find((tool) => tool.name === name);
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
  const { opened } = await teams.editTasks(team.id, {
    operations: [{ type: "add", title: "Ship" }],
  });
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: opened[0]!.id, patch: { status: "completed" } }],
  });
  expect(
    events.filter((event) => event.type === "message").map(({ message }) => message.content),
  ).toEqual([request.content, { type: "tasks_completed" }]);
  expect(broadcasts.mock.calls.map(([event]) => event.type)).toEqual([
    "team.upserted",
    "team.upserted",
  ]);
  expect(broadcasts.mock.lastCall?.[0]).toMatchObject({
    team: { pendingRequests: [expect.any(Object)], completedSequence: expect.any(Number) },
  });
  expect(deliver).not.toHaveBeenCalled();
  expect((await teams.getAgent(team.id))?.status?.state).toBe("working");
  await finishTeamAgentTurn(team.id, { waitingFor: "Your color choice" });
  await postTeamMessageFromSession("user-session", {
    id: "decision",
    teamId: team.id,
    content: "@builder use blue.",
  });
  expect(deliver.mock.calls.map(([id]) => id).sort()).toEqual([team.id, member.id].sort());
  expect((await teams.getTeam(team.id))?.pendingRequests).toEqual([]);
  expect((await teams.getAgent(team.id))?.status).toBeUndefined();
});

test("only the lead interrupts the agents its message wakes, and each wake records it", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Interrupt", ...TEAM_DEFAULTS });
  const { member } = await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "interrupted",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => deliver.mockRestore());

  await expect(
    sendTeamMessageFromAgent(member.id, { content: "@lead Stop.", interrupt: true }),
  ).rejects.toThrow("Only the team lead can interrupt agents.");
  expect(deliver).not.toHaveBeenCalled();

  await sendTeamMessageFromAgent(team.id, {
    content: "@builder Stop: don't delete the mirror.",
    interrupt: true,
  });
  const systemMessage = {
    type: "team_message" as const,
    senderName: expect.any(String),
    interrupt: true as const,
  };
  expect(deliver.mock.calls).toEqual([[member.id, { systemMessage, interrupt: true }]]);
  expect(await teams.listWakesSince(team.id, "")).toEqual([
    expect.objectContaining({ agentId: member.id, author: team.id, delivery: "interrupted" }),
  ]);
});

test.each([undefined, "Ship a useful release."])(
  "creating a Team with purpose %s starts avatar setup without creating a directory",
  async (purpose) => {
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
      purpose,
      directory,
      model: TEAM_DEFAULTS.model,
    });
    const [leadId, message, options] = await leadStarted.promise;

    expect(team.directory).toBe(directory);
    expect(team.purpose).toBe(purpose);
    await expect(stat(directory)).rejects.toThrow();
    expect(leadId).toBe(team.id);
    if (!("content" in message)) throw new Error("Expected the lead's initial prompt.");
    expect(message.content).toContain("update_team({avatar:{mark,color}})");
    expect(message.content).toContain("Before finishing this first turn");
    expect(message.content).toContain("must not wait for a purpose");
    expect(options).toMatchObject({
      sessionType: "worker",
      name: "Lead · Bitmap studio",
    });
  },
);

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

test("an Agent can attach media and documents to a durable Team message, but not other files", async () => {
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
  const notes = join(directory, "notes.md");
  const report = join(directory, "report.pdf");
  const archive = join(directory, "logs.zip");
  await Bun.write(screenshot, Buffer.from(PNG_BASE64, "base64"));
  await Bun.write(recording, "webm");
  await Bun.write(notes, "# Notes");
  await Bun.write(report, "%PDF-1.7");
  await Bun.write(archive, "zip");

  const message = await sendTeamMessageFromAgent(team.id, {
    content: "The layout is ready for review.",
    attachmentPaths: [screenshot, recording, notes, report],
  });

  expect(message).toMatchObject({
    sequence: 1,
    sender: { type: "agent", agentId: team.id },
    content: "The layout is ready for review.",
    attachments: [screenshot, recording, notes, report],
  });
  expect((await teams.listMessagesAfter(team.id)).at(-1)).toEqual(message);
  await expect(
    sendTeamMessageFromAgent(team.id, { content: "Logs", attachmentPaths: [archive] }),
  ).rejects.toThrow("not an image, video, Markdown, text, or PDF file");
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

test("agents read their queue, open tasks in full, closed ones compactly, and one task's thread", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Queue", ...TEAM_DEFAULTS });
  const { member } = await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => {
    releaseTeamEvents(team.id);
    deliver.mockRestore();
  });
  await editTeamTasksFromAgent(team.id, {
    operations: [
      { type: "add", title: "Polish", priority: "low", assigneeId: member.id },
      { type: "add", title: "Build", assigneeId: member.id, note: "Start with the parser." },
      { type: "add", title: "Fix the crash", priority: "high", assigneeId: member.id },
      { type: "add", title: "Ship", assigneeId: member.id },
      { type: "add", title: "Plan", assigneeId: team.id },
    ],
  });
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: "t4", patch: { status: "completed" } }],
  });

  const read = await invokeTool("read_team", {}, member.id, teamMemberTools);
  expect(read.yourTasks.map(({ taskId }: { taskId: string }) => taskId)).toEqual([
    "t3",
    "t2",
    "t1",
  ]);
  expect(read.tasks[1]).toEqual({
    taskId: "t2",
    title: "Build",
    status: "pending",
    priority: "normal",
    assigneeId: member.id,
    openedBy: team.id,
    threadSequence: expect.any(Number),
    openedAt: expect.any(String),
    updatedAt: expect.any(String),
    updatedBy: team.id,
  });
  expect(read.tasks[3]).toEqual({ taskId: "t4", title: "Ship", status: "completed" });
  expect((await invokeTool("read_team", {}, team.id, teamLeadTools)).yourTasks).toMatchObject([
    { taskId: "t5" },
  ]);

  const seenThrough = (await teams.getAgent(member.id))?.seenThrough;
  expect(await invokeTool("read_team", { taskId: "t2" }, member.id, teamMemberTools)).toMatchObject(
    {
      task: { taskId: "t2", title: "Build" },
      messages: [
        { content: { type: "task_opened", taskId: "t2" } },
        { content: "Start with the parser.", taskId: "t2" },
      ],
    },
  );
  expect((await teams.getAgent(member.id))?.seenThrough).toBe(seenThrough);
  const session = await invokeTool("read_team", { teamId: team.id, taskId: "t1" });
  expect(session).toMatchObject({
    task: { taskId: "t1" },
    messages: [{ content: { type: "task_opened", taskId: "t1" } }],
  });
  expect(session).not.toHaveProperty("yourTasks");
  await expect(
    invokeTool("read_team", { taskId: "t9" }, member.id, teamMemberTools),
  ).rejects.toThrow('Task "t9" was not found');
});

test("a saved task change wakes each agent once, with every task and what changed", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Routing", ...TEAM_DEFAULTS });
  const { member: builder } = await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const { member: critic } = await teams.createMember(teamAgent(team.id, "critic", "Critic"));
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "steered",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => {
    releaseTeamEvents(team.id);
    deliver.mockRestore();
  });
  const delivered = () => {
    const calls = Object.fromEntries(deliver.mock.calls.map(([id, message]) => [id, message]));
    deliver.mockClear();
    return calls;
  };
  const lead = teamLead(team.id);

  await editTeamTasksFromAgent(team.id, {
    operations: [
      {
        type: "add",
        title: "Parser",
        assigneeId: builder.id,
        note: "@critic please review the grammar with Builder.",
      },
      { type: "add", title: "Docs", assigneeId: builder.id },
    ],
  });
  expect(delivered()).toEqual({
    [builder.id]: {
      systemMessage: {
        type: "team_task",
        senderName: lead.name,
        tasks: [
          {
            taskId: "t1",
            title: "Parser",
            changes: ["assigned to you", "a new message for you in its thread"],
          },
          { taskId: "t2", title: "Docs", changes: ["assigned to you"] },
        ],
      },
      immediate: true,
    },
    [critic.id]: {
      systemMessage: {
        type: "team_task",
        senderName: lead.name,
        tasks: [
          { taskId: "t1", title: "Parser", changes: ["a new message for you in its thread"] },
        ],
      },
      immediate: true,
    },
  });
  expect(
    (await teams.listWakesSince(team.id, new Date(0).toISOString())).map(
      ({ agentId, cause, author }) => [agentId, cause, author],
    ),
  ).toEqual(
    expect.arrayContaining([
      [builder.id, "task", team.id],
      [critic.id, "task", team.id],
    ]),
  );

  // The assignee's own progress wakes no one; anyone else's message in its thread wakes it.
  await editTeamTasksFromAgent(builder.id, {
    operations: [
      { type: "update", taskId: "t1", patch: { status: "in_progress" }, note: "Starting." },
    ],
  });
  expect(delivered()).toEqual({});
  const [parser, docs] = await teams.listTasks(team.id);
  await postTeamMessage({
    id: "question",
    teamId: team.id,
    content: "Any blockers?",
    threadSequence: parser!.threadSequence!,
  });
  expect(delivered()).toEqual({
    [builder.id]: {
      systemMessage: { type: "team_message", senderName: "the user" },
      immediate: true,
    },
  });

  // Handing off reaches the lead, and closing a hand-off wakes no one, since its assignee has
  // moved on.
  await editTeamTasksFromAgent(builder.id, {
    operations: [{ type: "update", taskId: docs!.id, patch: { status: "in_review" } }],
  });
  expect(Object.keys(delivered())).toEqual([team.id]);
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: docs!.id, patch: { status: "completed" } }],
  });
  expect(delivered()).toEqual({});

  // An unassigned task's thread reaches the lead, and a paused team wakes no one.
  const { opened } = await teams.editTasks(team.id, {
    operations: [{ type: "add", title: "Triage" }],
  });
  await postTeamMessage({
    id: "triage",
    teamId: team.id,
    content: "Who takes this?",
    threadSequence: opened[0]!.threadSequence!,
  });
  expect(Object.keys(delivered())).toEqual([team.id]);
  await teams.editTeam({ teamId: team.id, paused: true });
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "assign", taskId: opened[0]!.id, assigneeId: critic.id }],
  });
  expect(delivered()).toEqual({});
});

/** A team whose lead assigns Builder tasks, with every delivery captured. */
async function reportingTeam() {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Reports", ...TEAM_DEFAULTS });
  const { member: builder } = await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => {
    releaseTeamEvents(team.id);
    deliver.mockRestore();
  });
  const delivered = () => {
    const calls = Object.fromEntries(deliver.mock.calls.map(([id, message]) => [id, message]));
    deliver.mockClear();
    return calls;
  };
  const assign = async (...tasks: { title: string; priority?: "high" | "low" }[]) => {
    await editTeamTasksFromAgent(team.id, {
      operations: tasks.map((task) => ({ type: "add", ...task, assigneeId: builder.id })),
    });
    delivered();
  };
  const thread = async (taskId: string) => {
    const task = (await teams.listTasks(team.id)).find(({ id }) => id === taskId)!;
    return (await teams.listThread(team.id, task.threadSequence!)).map(({ content }) => content);
  };
  return { teams, team, builder, delivered, assign, thread };
}

test("hand-offs and questions wake the lead once until it reads, and its summary lists them all", async () => {
  const { teams, team, builder, delivered, assign } = await reportingTeam();
  let now = Date.parse("2026-11-24T15:00:00.000Z");
  const tick = () => setSystemTime(new Date((now += 1_000)));
  onTestFinished(() => setSystemTime());
  tick();
  await assign({ title: "Parser" }, { title: "Docs" }, { title: "Lexer" });
  const [parser, docs, lexer] = await teams.listTasks(team.id);
  const leadWakes = () => {
    const calls = delivered();
    return calls[team.id] ? [calls[team.id]] : [];
  };
  // The lead's own changes stay out of its summary.
  tick();
  await readTeamForAgent(team.id);

  tick();
  await finishTeamAgentTurn(builder.id, {
    reports: [
      { taskId: "t1", status: "in_review", note: "Parsed. Close as completed." },
      { taskId: "t2", status: "in_progress", note: "Writing." },
      { taskId: "t3", status: "pending", note: "Not started." },
    ],
  });
  expect(leadWakes()).toEqual([
    {
      systemMessage: {
        type: "team_task",
        senderName: "Builder",
        tasks: [{ taskId: "t1", title: "Parser", changes: ["handed off for review"] }],
      },
      immediate: true,
    },
  ]);
  await editTeamTasksFromAgent(builder.id, {
    operations: [{ type: "update", taskId: "t2", patch: { status: "in_review" } }],
  });
  await sendTeamMessageFromAgent(builder.id, {
    content: "Which lexer generator?",
    threadSequence: lexer!.threadSequence!,
    request: true,
  });
  expect(leadWakes()).toEqual([]);

  tick();
  const { taskSummary } = await readTeamForAgent(team.id);
  expect(taskSummary).toEqual([
    {
      taskId: "t1",
      title: "Parser",
      status: "in_review",
      assigneeId: builder.id,
      changedBy: builder.id,
      note: { from: builder.id, content: "Parsed. Close as completed." },
    },
    {
      taskId: "t2",
      title: "Docs",
      status: "in_review",
      assigneeId: builder.id,
      changedBy: builder.id,
      note: { from: builder.id, content: "Writing." },
    },
    {
      taskId: "t3",
      title: "Lexer",
      status: "pending",
      assigneeId: builder.id,
      note: { from: builder.id, content: "Which lexer generator?" },
      question: true,
    },
  ]);
  tick();
  expect((await readTeamForAgent(team.id)).taskSummary).toEqual([]);

  // Reading starts over: the next hand-off wakes the lead again, and closing it wakes no one.
  tick();
  await editTeamTasksFromAgent(builder.id, {
    operations: [{ type: "update", taskId: "t3", patch: { status: "in_review" } }],
  });
  expect(leadWakes()).toHaveLength(1);
  await editTeamTasksFromAgent(team.id, {
    operations: [
      { type: "update", taskId: parser!.id, patch: { status: "completed" } },
      { type: "update", taskId: docs!.id, patch: { status: "cut" } },
    ],
  });
  expect(delivered()).toEqual({});

  // A lead turn that ends without reading gives its wake up, so the next hand-off wakes it again.
  await endTeamAgentTurn(teams, team.id, "stopped");
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: lexer!.id, patch: { status: "in_progress" } }],
  });
  delivered();
  await editTeamTasksFromAgent(builder.id, {
    operations: [{ type: "update", taskId: lexer!.id, patch: { status: "in_review" } }],
  });
  expect(leadWakes()).toHaveLength(1);
});

test("an agent reads other agents' task threads only where they mention it", async () => {
  const { teams, team, builder, assign } = await reportingTeam();
  const { member: critic } = await teams.createMember(teamAgent(team.id, "critic", "Critic"));
  await assign({ title: "Parser" });
  await editTeamTasksFromAgent(team.id, { operations: [{ type: "add", title: "Triage" }] });
  const [parser, triage] = await teams.listTasks(team.id);
  for (const agentId of [team.id, builder.id, critic.id]) await readTeamForAgent(agentId);
  const post = (content: string, threadSequence: number) =>
    postTeamMessage({ id: crypto.randomUUID(), teamId: team.id, content, threadSequence });
  await post("How is the grammar going?", parser!.threadSequence!);
  await post("@critic please look at the grammar.", parser!.threadSequence!);
  await post("Who takes this?", triage!.threadSequence!);
  await postTeamMessage({ id: "top", teamId: team.id, content: "Thanks, everyone." });

  const read = async (agentId: string) =>
    (await readTeamForAgent(agentId)).messages.map(({ content }) => content);
  expect(await read(builder.id)).toEqual([
    "How is the grammar going?",
    "@critic please look at the grammar.",
    "Thanks, everyone.",
  ]);
  expect(await read(critic.id)).toEqual([
    "@critic please look at the grammar.",
    "Thanks, everyone.",
  ]);
  expect(await read(team.id)).toEqual(["Who takes this?", "Thanks, everyone."]);
});

test("an open task losing its assignee wakes the lead once per change", async () => {
  const { teams, team, builder, delivered, assign } = await reportingTeam();
  await assign({ title: "Parser" }, { title: "Docs" });
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: "t2", patch: { status: "completed" } }],
  });
  delivered();

  await detachTeamAgentSession(builder.id);
  expect(delivered()).toEqual({
    [team.id]: {
      systemMessage: {
        type: "team_task",
        tasks: [
          {
            taskId: "t1",
            title: "Parser",
            changes: ["lost its assignee, who was removed from the team"],
          },
        ],
      },
      immediate: true,
    },
  });
  expect((await teams.listTasks(team.id)).map(({ assigneeId }) => assigneeId)).toEqual([
    undefined,
    undefined,
  ]);
  expect((await readTeamForAgent(team.id)).taskSummary).toEqual([
    { taskId: "t1", title: "Parser", status: "pending", changedBy: builder.id },
  ]);
});

test("an assignee asks the user in its task's thread, and the reply there answers it and wakes only the assignee", async () => {
  const { teams, team, builder, delivered, assign } = await reportingTeam();
  await assign({ title: "Parser" });
  const threadSequence = (await teams.listTasks(team.id))[0]!.threadSequence!;
  const ask = (input: object) =>
    invokeTool(
      "send_team_message",
      { content: "Which grammar?", request: true, ...input },
      builder.id,
      teamMemberTools,
    );

  await expect(ask({})).rejects.toThrow(
    "Ask the user only in the thread of an open task assigned to you.",
  );
  const { sequence } = await ask({ threadSequence });
  expect((await teams.getTeam(team.id))!.pendingRequests).toEqual([
    { sequence, threadSequence, agentId: builder.id },
  ]);
  // The lead hears of it with its hand-offs, merged.
  expect(delivered()).toEqual({
    [team.id]: {
      systemMessage: {
        type: "team_task",
        tasks: [
          {
            taskId: "t1",
            title: "Parser",
            changes: ["Builder asked the user a question in its thread"],
          },
        ],
      },
      immediate: true,
    },
  });

  await postTeamMessage({ id: "answer", teamId: team.id, content: "PEG.", threadSequence });
  expect(delivered()).toEqual({
    [builder.id]: {
      systemMessage: { type: "team_message", senderName: "the user" },
      immediate: true,
    },
  });
  expect((await teams.getTeam(team.id))!.pendingRequests).toEqual([]);
});

test("a finish reports on every task its turn was woken for, each note posting into its thread", async () => {
  const { teams, team, builder, delivered, assign, thread } = await reportingTeam();
  await assign({ title: "Parser" }, { title: "Docs" });
  expect((await teams.getMember(builder.id))?.turnTasks).toEqual(["t1", "t2"]);

  await expect(
    finishTeamAgentTurn(builder.id, {
      reports: [{ taskId: "t1", status: "in_progress", note: "Parsing." }],
    }),
  ).rejects.toThrow("This turn was woken for t2.");
  expect((await teams.listTasks(team.id)).map(({ status }) => status)).toEqual([
    "pending",
    "pending",
  ]);

  await finishTeamAgentTurn(builder.id, {
    reports: [
      { taskId: "t1", status: "in_progress", note: "Parsing." },
      { taskId: "t2", status: "blocked", note: "Docs wait for the parser." },
    ],
  });
  expect((await teams.listTasks(team.id)).map(({ status }) => status)).toEqual([
    "in_progress",
    "blocked",
  ]);
  expect((await thread("t1")).slice(1)).toEqual(["Parsing."]);
  expect((await thread("t2")).slice(1)).toEqual(["Docs wait for the parser."]);
  expect((await teams.getMember(builder.id))?.turnTasks).toBeUndefined();
  expect(delivered()).toEqual({});

  // A task the lead takes away mid-turn no longer needs a report.
  await postTeamMessage({
    id: "nudge",
    teamId: team.id,
    content: "How is it going?",
    threadSequence: (await teams.listTasks(team.id))[0]!.threadSequence!,
  });
  expect((await teams.getMember(builder.id))?.turnTasks).toEqual(["t1"]);
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "assign", taskId: "t1", assigneeId: null }],
  });
  await finishTeamAgentTurn(builder.id);
});

test("a turn that ends without its report notes it in the task's thread and wakes the assignee once", async () => {
  const { teams, team, builder, delivered, assign, thread } = await reportingTeam();
  await assign({ title: "Parser" });
  const unreported = {
    type: "task_turn_ended",
    taskId: "t1",
    agentId: builder.id,
    outcome: "unreported",
  } as const;

  await endTeamAgentTurn(teams, builder.id, "unreported");
  expect((await thread("t1")).slice(1)).toEqual([unreported]);
  expect(delivered()).toEqual({
    [builder.id]: {
      systemMessage: {
        type: "team_task",
        tasks: [
          {
            taskId: "t1",
            title: "Parser",
            changes: ["your last turn on it ended without reporting on it"],
          },
        ],
      },
      immediate: true,
    },
  });
  expect((await teams.getMember(builder.id))?.turnTasks).toEqual(["t1"]);

  await endTeamAgentTurn(teams, builder.id, "unreported");
  expect((await thread("t1")).slice(1)).toEqual([unreported, unreported]);
  expect(delivered()).toEqual({});
  expect((await teams.getMember(builder.id))?.turnTasks).toBeUndefined();

  // Replying to the note joins the task's thread, and a report starts the count over.
  const [note] = (
    await teams.listThread(team.id, (await teams.listTasks(team.id))[0]!.threadSequence!)
  ).slice(-1);
  const reply = await postTeamMessage({
    id: "reply",
    teamId: team.id,
    content: "Please pick this up.",
    threadSequence: note!.sequence,
  });
  expect(reply.threadSequence).toBe((await teams.listTasks(team.id))[0]!.threadSequence);
  await finishTeamAgentTurn(builder.id, {
    reports: [{ taskId: "t1", status: "in_progress", note: "On it." }],
  });
  delivered();
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: "t1", patch: { priority: "high" } }],
  });
  delivered();
  await endTeamAgentTurn(teams, builder.id, "unreported");
  expect(Object.keys(delivered())).toEqual([builder.id]);
});

test("a failed or stopped task turn notes it in the thread and wakes the lead once", async () => {
  const { teams, team, builder, delivered, assign, thread } = await reportingTeam();
  await assign({ title: "Parser" }, { title: "Docs" });

  await endTeamAgentTurn(teams, builder.id, "failed", "Usage limit reached.");
  expect((await thread("t1")).slice(1)).toEqual([
    {
      type: "task_turn_ended",
      taskId: "t1",
      agentId: builder.id,
      outcome: "failed",
      error: "Usage limit reached.",
    },
  ]);
  expect(delivered()).toEqual({
    [team.id]: {
      systemMessage: {
        type: "team_task",
        tasks: [
          { taskId: "t1", title: "Parser", changes: ["Builder's turn on it failed"] },
          { taskId: "t2", title: "Docs", changes: ["Builder's turn on it failed"] },
        ],
      },
      immediate: true,
    },
  });

  await postTeamMessage({
    id: "retry",
    teamId: team.id,
    content: "Try again.",
    threadSequence: (await teams.listTasks(team.id))[0]!.threadSequence!,
  });
  delivered();
  await endTeamAgentTurn(teams, builder.id, "stopped");
  expect((await thread("t1")).at(-1)).toMatchObject({ outcome: "stopped" });
  expect(delivered()).toEqual({
    [team.id]: {
      systemMessage: {
        type: "team_task",
        tasks: [{ taskId: "t1", title: "Parser", changes: ["Builder's turn on it was stopped"] }],
      },
      immediate: true,
    },
  });

  // The lead's own failed turn isn't sent back to it.
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "add", title: "Release", assigneeId: team.id }],
  });
  await postTeamMessageFromSession("user-session", {
    id: "release",
    teamId: team.id,
    content: "Ship it.",
    threadSequence: (await teams.listTasks(team.id))[2]!.threadSequence!,
  });
  delivered();
  await endTeamAgentTurn(teams, team.id, "failed");
  expect((await thread("t3")).at(-1)).toMatchObject({ outcome: "failed" });
  expect(delivered()).toEqual({});
});

test("a report can continue its task later, at most three reports in a row", async () => {
  const { teams, team, builder, delivered, assign } = await reportingTeam();
  setSystemTime(new Date("2026-11-24T15:00:00.000Z"));
  onTestFinished(() => setSystemTime());
  await assign({ title: "Build" });
  const continueLater = {
    taskId: "t1",
    status: "in_progress",
    note: "Waiting on CI.",
    continueAfterMinutes: 30,
  } as const;

  await finishTeamAgentTurn(builder.id, { reports: [continueLater] });
  await wakeDueTeamAgents(new Date("2026-11-24T15:29:00.000Z"));
  expect(delivered()).toEqual({});
  await wakeDueTeamAgents(new Date("2026-11-24T15:30:00.000Z"));
  await wakeDueTeamAgents(new Date("2026-11-24T15:31:00.000Z"));
  expect(delivered()).toEqual({
    [builder.id]: {
      systemMessage: {
        type: "team_task",
        tasks: [
          {
            taskId: "t1",
            title: "Build",
            changes: ["time to continue it, as your last report asked"],
          },
        ],
      },
      immediate: true,
    },
  });
  expect((await teams.getMember(builder.id))?.turnTasks).toEqual(["t1"]);

  await finishTeamAgentTurn(builder.id, { reports: [continueLater] });
  await finishTeamAgentTurn(builder.id, { reports: [continueLater] });
  await expect(finishTeamAgentTurn(builder.id, { reports: [continueLater] })).rejects.toThrow(
    "t1 has continued 3 times in a row.",
  );
  await finishTeamAgentTurn(builder.id, {
    reports: [{ taskId: "t1", status: "in_progress", note: "Still on it." }],
  });
  await finishTeamAgentTurn(builder.id, { reports: [continueLater] });

  // A new status or assignee cancels the continuation.
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: "t1", patch: { status: "blocked" } }],
  });
  delivered();
  await wakeDueTeamAgents(new Date("2026-11-24T18:00:00.000Z"));
  expect(delivered()).toEqual({});
});

test("handing a task off wakes its assignee for its highest-priority pending task after the turn", async () => {
  const { teams, team, builder, delivered, assign } = await reportingTeam();
  await assign(
    { title: "Parser" },
    { title: "Docs", priority: "low" },
    { title: "Fix", priority: "high" },
  );

  await finishTeamAgentTurn(builder.id, {
    reports: [
      { taskId: "t1", status: "in_review", note: "Parsed. Close as completed." },
      { taskId: "t2", status: "pending", note: "Not started." },
      { taskId: "t3", status: "pending", note: "Not started." },
    ],
  });
  const calls = delivered();
  expect(Object.keys(calls).sort()).toEqual([builder.id, team.id].sort());
  expect(calls[builder.id]).toEqual({
    systemMessage: {
      type: "team_task",
      tasks: [
        {
          taskId: "t3",
          title: "Fix",
          changes: ["your highest-priority pending task, now that you handed off t1"],
        },
      ],
    },
  });
  expect((await teams.getMember(builder.id))?.turnTasks).toEqual(["t3"]);

  // A report that hands nothing off leaves the queue alone.
  await finishTeamAgentTurn(builder.id, {
    reports: [{ taskId: "t3", status: "in_progress", note: "Fixing." }],
  });
  expect(delivered()).toEqual({});
});

test("a turn's end is settled from how its execution ended, and after a restart", async () => {
  const models = spyOn(providerCatalog, "listModels").mockResolvedValue([]);
  onTestFinished(() => models.mockRestore());
  const { teams, team, builder, delivered, assign, thread } = await reportingTeam();
  onTestFinished(() => deleteSessionState(builder.id));
  await assign({ title: "Parser" });
  setSessionStatus(builder.id, "running");
  onTestFinished(await startTeams());
  const outcomes = async () =>
    (await thread("t1")).flatMap((content) =>
      typeof content === "object" && content.type === "task_turn_ended" ? [content.outcome] : [],
    );
  const settled = async (count: number) => {
    for (let attempt = 0; attempt < 200 && (await outcomes()).length < count; attempt++) {
      await Bun.sleep(5);
    }
    return (await outcomes()).at(-1);
  };
  const nudge = async (id: string) => {
    await postTeamMessage({
      id,
      teamId: team.id,
      content: "How is it going?",
      threadSequence: (await teams.listTasks(team.id))[0]!.threadSequence!,
    });
    delivered();
  };

  setSessionStatus(builder.id, "idle");
  publishSessionCompletion(builder.id, { status: "completed" });
  expect(await settled(1)).toBe("unreported");
  expect(Object.keys(delivered())).toEqual([builder.id]);

  setSessionStatus(builder.id, "running");
  setSessionStatus(builder.id, "unread");
  publishSessionCompletion(builder.id, { status: "failed", error: "Boom." });
  expect(await settled(2)).toBe("failed");
  expect(Object.keys(delivered())).toEqual([team.id]);

  await nudge("stop");
  setSessionStatus(builder.id, "running");
  setSessionStatus(builder.id, "idle");
  expect(await settled(3)).toBe("stopped");
  expect(Object.keys(delivered())).toEqual([team.id]);

  // A turn the server's stop interrupted is settled when it starts again.
  await nudge("restart");
  onTestFinished(await startTeams());
  expect(await outcomes()).toEqual(["unreported", "failed", "stopped", "stopped"]);
  expect((await teams.getMember(builder.id))?.turnTasks).toBeUndefined();
  expect(Object.keys(delivered())).toEqual([team.id]);
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
    preview: { kind: "url", url: "http://127.0.0.1:3000" },
  });
  const outcome = { artifactId: artifact.artifactId, diff: { added: 32, removed: 8 } };
  expect(
    await invokeTool(
      "edit_team_tasks",
      { operations: [{ type: "add", title: "Synthesize the evidence" }] },
      team.id,
    ),
  ).toEqual({ opened: [{ taskId: "t1", title: "Synthesize the evidence" }] });
  await invokeTool(
    "edit_team_tasks",
    {
      operations: [{ type: "update", taskId: "t1", patch: { ...outcome, status: "in_progress" } }],
    },
    team.id,
  );

  const result = await invokeTool("read_team", { teamId: team.id });
  expect(result).toMatchObject({
    team: {
      purpose: "Turn the evidence into a useful recommendation.",
      preview: { kind: "url", url: "http://127.0.0.1:3000" },
    },
    tasks: [{ taskId: "t1", title: "Synthesize the evidence", status: "in_progress", ...outcome }],
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

test("lead-authored team icons reach detail observers, the catalog, and agent context without wakes", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Design", ...TEAM_DEFAULTS });
  const initial = (await getTeamSnapshot(team.id))!;
  const events: TeamEvent[] = [];
  onTestFinished(subscribeTeamEvents(team.id, (event) => events.push(event)));
  onTestFinished(() => releaseTeamEvents(team.id));
  const broadcast = spyOn(workspaceEvents, "broadcast").mockImplementation(() => {});
  const deliver = spyOn(sessionRuntime, "deliverSessionMessage");
  onTestFinished(() => {
    broadcast.mockRestore();
    deliver.mockRestore();
  });
  const avatar = { mark: "M5 12h14M12 5v14", color: "#7c3aed" };

  expect(await invokeTool("update_team", { avatar }, team.id)).toMatchObject({
    teamId: team.id,
    avatar,
  });
  expect(events).toEqual([{ type: "avatar", revision: initial.revision + 1, avatar }]);
  expect(broadcast).toHaveBeenCalledWith({
    type: "team.upserted",
    team: { ...team, avatar },
  });
  expect(events.reduce(reduceTeamState, initial)).toEqual((await getTeamSnapshot(team.id))!);
  expect(await invokeTool("read_team", { teamId: team.id })).toMatchObject({
    team: { avatar },
  });
  expect(deliver).not.toHaveBeenCalled();
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

  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "add", title: "Verify" }],
  });
  await updateTeamFromLead(team.id, {
    preview: { kind: "url", url: "http://localhost:3000" },
  });
  const model = { provider: "copilot", name: "gpt-6" };
  await editTeam({ teamId: team.id, model });
  await markTeamRead(team.id, 100);
  await markTeamRead(team.id, 1);
  await updateTeamFromLead(team.id, {
    preview: { kind: "url", url: "http://localhost:3000" },
  });
  const beforeUpdate = (await teams.getTeam(team.id))!;
  await editTeamTasksFromAgent(team.id, {
    operations: [{ type: "update", taskId: "t1", patch: { diff: { added: 3, removed: 1 } } }],
  });
  // Updating a task stays out of the transcript and the catalog's ordering.
  expect(await teams.getTeam(team.id)).toEqual(beforeUpdate);
  await editTeam({ teamId: team.id, model });
  expect(teamEvents.slice(3).map(({ type, revision }) => [type, revision])).toEqual([
    ["message", 4],
    ["task", 5],
    ["message", 6],
    ["model", 7],
    ["read", 8],
    ["task", 9],
  ]);
  expect(teamEvents[3]).toMatchObject({
    message: { sequence: 4, content: { type: "task_opened", taskId: "t1" } },
  });
  expect(teamEvents.at(-2)).toEqual({
    type: "read",
    revision: 8,
    seenThrough: 5,
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
  await finishTeamAgentTurn(member.id, { waitingFor: "implementation feedback" });

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
  const models = spyOn(providerCatalog, "listModels").mockResolvedValue([]);
  onTestFinished(() => models.mockRestore());
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Activity", ...TEAM_DEFAULTS });
  const { member } = await teams.createMember(teamAgent(team.id, "active", "Active"));
  const { member: waiting } = await teams.createMember(teamAgent(team.id, "waiting", "Waiting"));
  await setTeamAgentStatus(team.id, { status: "Left over from shutdown" });
  await setTeamAgentStatus(member.id, { status: "Still running" });
  await finishTeamAgentTurn(waiting.id, { waitingFor: "CI", wakeAfterMinutes: 20 });
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

  await finishTeamAgentTurn(team.id, { waitingFor: "CI to finish", wakeAfterMinutes: 20 });
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

  await finishTeamAgentTurn(team.id, { waitingFor: "CI to finish", wakeAfterMinutes: 20 });
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

test.each(["lead", "member"] as const)(
  "a due routine privately wakes its %s without adding to the transcript",
  async (recipient) => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Watch", ...TEAM_DEFAULTS });
    const { member } = await teams.createMember(teamAgent(team.id, "watcher", "Watcher"));
    const agentId = recipient === "member" ? member.id : undefined;
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
      agentId,
    });
    const { latestSequence } = (await teams.getTeam(team.id))!;
    await wakeDueTeamAgents(new Date(Date.now() + 61 * 60_000));

    expect(
      events.filter((event) => event.type === "message").map((event) => event.message.content),
    ).toEqual([{ type: "routine_scheduled", routine }]);
    expect(deliver.mock.calls).toEqual([
      [
        agentId ?? team.id,
        {
          systemMessage: { type: "team_routine", title: "CI", prompt: "Check CI" },
          immediate: true,
        },
      ],
    ]);
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(latestSequence);
  },
);

test.each(["lead", "member"] as const)(
  "running a routine wakes its %s now and leaves its schedule alone",
  async (recipient) => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Watch", ...TEAM_DEFAULTS });
    const { member } = await teams.createMember(teamAgent(team.id, "watcher", "Watcher"));
    const agentId = recipient === "member" ? member.id : undefined;
    const deliver = spyOnDelivery();
    const routine = await setTeamRoutineFromLead(team.id, {
      title: "CI",
      schedule: "0 * * * *",
      prompt: "Check CI",
      agentId,
    });
    const wake: Parameters<typeof sessionRuntime.deliverSessionMessage> = [
      agentId ?? team.id,
      {
        systemMessage: { type: "team_routine", title: "CI", prompt: "Check CI" },
        immediate: true,
      },
    ];

    expect(await runTeamRoutine(team.id, routine.id)).toBe(true);
    await wakeDueTeamAgents(new Date(Date.now() + 61 * 60_000));

    expect(deliver.mock.calls).toEqual([wake, wake]);
  },
);

test("pause stops the entire roster, saves messages without delivery, and resume wakes only the lead", async () => {
  const teams = await openTeams();
  const team = await createStoredTeam(teams, { name: "Pause", ...TEAM_DEFAULTS });
  await teams.createMember(teamAgent(team.id, "builder", "Builder"));
  const routine = await setTeamRoutineFromLead(team.id, {
    title: "CI",
    schedule: "0 * * * *",
    prompt: "Check CI",
    agentId: "builder",
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
