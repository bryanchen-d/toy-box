import { teamAgent, createStoredTeam } from "@teams/server/testFixtures";
import { describe, expect, onTestFinished, setSystemTime, test } from "bun:test";
import type { TeamTask } from "@teams/model";
import { machineFile, sessionFile, workspaceFileId } from "@files/model";
import { createTestDatabase } from "@/server/database";
import { TeamDatabase } from "./database";

const TEAM_DEFAULTS = {
  purpose: "Coordinate the work to a useful result.",
  model: { provider: "copilot", name: "gpt-5.5" },
} as const;

async function openTeams() {
  const database = await createTestDatabase();
  onTestFinished(() => database.close());
  return new TeamDatabase(database);
}

describe("team message search", () => {
  async function setup() {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Search", ...TEAM_DEFAULTS });
    const post = async (
      content: string,
      options: { teamId?: string; threadSequence?: number; user?: true } = {},
    ) =>
      (
        await teams.appendMessage({
          id: crypto.randomUUID(),
          teamId: options.teamId ?? team.id,
          sender: options.user ? { type: "user" } : { type: "agent", agentId: team.id },
          content,
          threadSequence: options.threadSequence,
        })
      ).message;
    return { teams, team, post };
  }

  test("team search includes replies; thread search includes only its root and replies", async () => {
    const { teams, team, post } = await setup();
    const root = await post("First needle", { user: true });
    const reply = await post("Reply NEEDLE", { threadSequence: root.sequence });
    const otherThread = await post("Another needle");
    const other = await createStoredTeam(teams, { name: "Other", ...TEAM_DEFAULTS });
    await post("Other team needle", { teamId: other.id, user: true });
    await teams.updateTeam(team.id, { purpose: "needle in a system message" });
    const before = await teams.getSnapshot(team.id, 100);
    const matches = await teams.searchMessages(team.id, "needle");
    expect(matches).toEqual([
      {
        sequence: otherThread.sequence,
        threadSequence: otherThread.sequence,
        sender: { type: "agent", agentId: team.id },
        before: "Another ",
        match: "needle",
        after: "",
      },
      {
        sequence: reply.sequence,
        threadSequence: root.sequence,
        sender: { type: "agent", agentId: team.id },
        before: "Reply ",
        match: "NEEDLE",
        after: "",
      },
      {
        sequence: root.sequence,
        threadSequence: root.sequence,
        sender: { type: "user" },
        before: "First ",
        match: "needle",
        after: "",
      },
    ]);
    expect(await teams.searchMessages(team.id, "needle", root.sequence)).toEqual(matches.slice(1));
    expect(await teams.searchMessages(team.id, "needle", reply.sequence)).toEqual(matches.slice(1));
    expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
  });

  test("search reaches unloaded history and uses literal Unicode-aware matching", async () => {
    const { teams, team, post } = await setup();
    const old = await post("İstanbul [a-z]+.*? Äpfel 100%_done");
    for (let index = 0; index < 130; index++) await post(`Recent unrelated ${index}`);
    expect(
      (await teams.getSnapshot(team.id, 100))?.messages.some(
        ({ sequence }) => sequence === old.sequence,
      ),
    ).toBe(false);
    expect(await teams.searchMessages(team.id, "[A-Z]+.*?")).toEqual([
      {
        sequence: old.sequence,
        threadSequence: old.sequence,
        sender: { type: "agent", agentId: team.id },
        before: "İstanbul ",
        match: "[a-z]+.*?",
        after: " Äpfel 100%_done",
      },
    ]);
    expect((await teams.searchMessages(team.id, "ÄPFEL"))[0]?.match).toBe("Äpfel");
    expect((await teams.searchMessages(team.id, "100%_done"))[0]?.sequence).toBe(old.sequence);
    expect(await teams.searchMessages(team.id, "[not found]")).toEqual([]);
  });

  test("results are the 20 newest matches and contain bounded snippets", async () => {
    const { teams, team, post } = await setup();
    for (let index = 0; index < 25; index++)
      await post(`${"a".repeat(100)}Needle${"b".repeat(200)}`);
    const matches = await teams.searchMessages(team.id, "needle");
    expect(matches.map(({ sequence }) => sequence)).toEqual(
      Array.from({ length: 20 }, (_, index) => 25 - index),
    );
    expect(matches[0]).toMatchObject({
      before: "..." + "a".repeat(60),
      match: "Needle",
      after: "b".repeat(100) + "...",
    });
  });

  test("missing teams and unavailable threads fail instead of searching another scope", async () => {
    const { teams, team } = await setup();
    await expect(teams.searchMessages("missing", "needle")).rejects.toThrow("Team not found");
    await expect(teams.searchMessages(team.id, "needle", 999)).rejects.toThrow();
    const change = await teams.updateTeam(team.id, { purpose: "System only" });
    const system = change.events.find((event) => event.type === "message")!.message;
    await expect(teams.searchMessages(team.id, "needle", system.sequence)).rejects.toThrow();
  });
});

describe("team attention", () => {
  async function setup() {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Attention", ...TEAM_DEFAULTS });
    const post = (
      content: string,
      sender: { type: "user" } | { type: "agent"; agentId: string } = {
        type: "agent",
        agentId: team.id,
      },
    ) =>
      teams.appendMessage({
        id: crypto.randomUUID(),
        teamId: team.id,
        sender,
        content,
      });
    /** Reopens one task, then completes the list, returning the completion message. */
    const complete = async (title = "Release") => {
      await teams.updateTeam(team.id, {
        tasks: [{ id: "release", title, status: "pending" }],
      });
      const { events } = await teams.updateTeam(team.id, {
        tasks: [{ id: "release", title, status: "done" }],
      });
      return events.find((event) => event.type === "message")!.message;
    };
    /** Sends a lead message flagged as a user request, returning the question. */
    const ask = async (content: string) => {
      const { events } = await teams.appendMessage({
        id: crypto.randomUUID(),
        teamId: team.id,
        sender: { type: "agent", agentId: team.id },
        content,
        request: true,
      });
      return events[0]!.message;
    };
    return { teams, team, post, complete, ask };
  }

  test("rewriting a complete list never repeats completion; reopening a task does", async () => {
    const { teams, team } = await setup();
    const update = async (tasks: TeamTask[]) =>
      (await teams.updateTeam(team.id, { tasks })).events.filter(
        (event) => event.type === "message",
      ).length;
    const release = { id: "release", title: "Release", status: "done" } as const;
    expect(await update([release])).toBe(1);
    expect((await teams.getTeam(team.id))?.completedSequence).toBe(1);
    expect(await update([release, { id: "notes", title: "Notes", status: "done" }])).toBe(0);
    expect(await update([release, { id: "ship", title: "Ship", status: "pending" }])).toBe(0);
    expect(await update([release, { id: "ship", title: "Ship", status: "done" }])).toBe(1);
    expect(await update([])).toBe(0);
  });

  test("a request persists on the lead message without an extra transcript entry", async () => {
    const { teams, team, ask } = await setup();
    const question = await ask("Choose a name.");
    expect(question).toMatchObject({ sequence: 1, content: "Choose a name.", request: true });
    expect(await teams.listMessagesAfter(team.id)).toEqual([question]);
    expect((await teams.getTeam(team.id))?.requestSequence).toBe(1);
  });

  test("catalog attention includes messages outside the loaded window", async () => {
    const { teams, team, post, complete, ask } = await setup();
    await complete();
    await ask("What should we do next?");
    for (let index = 0; index < 105; index++) await post(`Update ${index}`);
    const snapshot = await teams.getSnapshot(team.id, 100);
    expect(snapshot?.messages).toHaveLength(100);
    expect(snapshot?.request).toMatchObject({ content: "What should we do next?" });
    expect((await teams.listTeams()).teams[0]).toMatchObject({
      completedSequence: 1,
      requestSequence: 2,
    });
    await ask("Which follow-up should we prioritize?");
    expect((await teams.getSnapshot(team.id, 1))?.request).toMatchObject({
      content: "Which follow-up should we prioritize?",
    });
  });

  test("reads and replies persist attention cursors with their receipts", async () => {
    const { teams, team, post, complete, ask } = await setup();
    const done = await complete();
    const question = await ask("What should we do next?");
    const through = question.sequence;
    expect(await teams.markUserSeen(team.id, through)).toMatchObject({
      team: { completedSequence: done.sequence, requestSequence: question.sequence },
      events: [{ type: "read", seenThrough: through }],
    });
    const reply = await post("Build the next batch.", { type: "user" });
    expect(reply).toMatchObject({
      acknowledgedRequest: true,
      team: { requestSequence: null },
    });
    expect(reply.team).toEqual((await teams.getTeam(team.id))!);
    expect((await teams.getSnapshot(team.id, 1))?.request).toBeNull();
    expect(
      (await teams.listMessagesAfter(team.id)).filter(({ sender }) => sender.type === "system"),
    ).toEqual([done]);
  });

  test("only the lead can request input", async () => {
    const { teams, team } = await setup();
    const { member } = await teams.createMember(teamAgent(team.id, "member", "Member"));
    const other = await createStoredTeam(teams, { name: "Other", ...TEAM_DEFAULTS });
    const senders = [
      { type: "user" },
      { type: "agent", agentId: member.id },
      { type: "agent", agentId: other.id },
    ] as const;
    for (const sender of senders) {
      await expect(
        teams.appendMessage({
          id: crypto.randomUUID(),
          teamId: team.id,
          sender,
          content: "Which color?",
          request: true,
        }),
      ).rejects.toThrow("Only the team lead can request input.");
    }
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(1);
  });

  test("a rejected reply preserves attention and allocates no sequence number", async () => {
    const { teams, team, post, ask } = await setup();
    const request = await ask("Please approve.");
    const before = await teams.getSnapshot(team.id, 100);
    await expect(
      teams.appendMessage({
        id: request.id,
        teamId: team.id,
        sender: { type: "user" },
        content: "Approved.",
      }),
    ).rejects.toThrow();
    expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
    expect((await post("Next message")).message.sequence).toBe(2);
  });
});

describe("team threads", () => {
  async function setup() {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Threads", ...TEAM_DEFAULTS });
    const post = async (content: string, threadSequence?: number) =>
      (
        await teams.appendMessage({
          id: crypto.randomUUID(),
          teamId: team.id,
          sender: { type: "agent", agentId: team.id },
          content,
          ...(threadSequence === undefined ? {} : { threadSequence }),
        })
      ).message;
    return { teams, team, post };
  }

  test("a reply joins the thread of the message it answers", async () => {
    const { post } = await setup();
    const root = await post("Add dark mode?");
    expect(root).not.toHaveProperty("threadSequence");
    expect(await post("On it.", root.sequence)).toMatchObject({
      sequence: 2,
      threadSequence: root.sequence,
    });
  });

  test("replying to a reply joins the same thread, so threads stay one level deep", async () => {
    const { post } = await setup();
    const root = await post("Add dark mode?");
    const reply = await post("On it.", root.sequence);
    expect((await post("Done.", reply.sequence)).threadSequence).toBe(root.sequence);
  });

  test("replies persist with their thread across reads", async () => {
    const { teams, team, post } = await setup();
    const root = await post("Add dark mode?");
    const reply = await post("On it.", root.sequence);
    expect(await teams.listMessagesAfter(team.id)).toEqual([root, reply]);
    expect((await teams.getSnapshot(team.id, 100))?.messages).toEqual([root, reply]);
  });

  test("only a user or agent message in the same team starts a thread", async () => {
    const { teams, team, post } = await setup();
    const other = await createStoredTeam(teams, { name: "Other", ...TEAM_DEFAULTS });
    for (const content of ["One", "Two", "Three"]) {
      await teams.appendMessage({
        id: crypto.randomUUID(),
        teamId: other.id,
        sender: { type: "user" },
        content,
      });
    }
    await teams.updateTeam(team.id, { name: "Renamed" });
    const latest = (await teams.getTeam(team.id))!.latestSequence;
    const onlyElsewhere = (await teams.getTeam(other.id))!.latestSequence;
    expect(onlyElsewhere).toBeGreaterThan(latest);
    for (const sequence of [latest, onlyElsewhere]) {
      await expect(post("Reply", sequence)).rejects.toThrow(
        "Reply to a user or agent message in this team.",
      );
    }
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(latest);
  });

  test("a thread lists its top-level message and every reply, from any message in it", async () => {
    const { teams, team, post } = await setup();
    const root = await post("Add dark mode?");
    const reply = await post("On it.", root.sequence);
    await post("Separately, the build is green.");
    const done = await post("Done.", root.sequence);
    for (const sequence of [root.sequence, reply.sequence]) {
      expect(await teams.listThread(team.id, sequence)).toEqual([root, reply, done]);
    }
  });
});

describe("team task edits", () => {
  async function setup() {
    const database = await createTestDatabase();
    onTestFinished(() => database.close());
    const teams = new TeamDatabase(database);
    const team = await createStoredTeam(teams, { name: "Outcomes", ...TEAM_DEFAULTS });
    const task = { id: "t1", title: "Review", status: "pending" } as const;
    const file = machineFile("/workspace/review.md");
    await teams.shareArtifact({
      teamId: team.id,
      file,
      title: "Review findings",
      actor: { type: "agent", agentId: team.id },
    });
    await teams.updateTeam(team.id, { tasks: [task] });
    return { database, teams, team, task, artifactId: workspaceFileId(file) };
  }

  test("only the final batch state can advance revision or complete the list", async () => {
    const { teams, team } = await setup();
    const before = await teams.getSnapshot(team.id, 100);
    expect(
      (
        await teams.editTasks(team.id, {
          operations: [
            { type: "update", taskId: "t1", patch: { status: "done" } },
            { type: "update", taskId: "t1", patch: { status: "pending" } },
          ],
        })
      ).events,
    ).toEqual([]);
    expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
  });

  test("serialized field edits preserve concurrent outcomes on the same task", async () => {
    const { teams, team, task, artifactId } = await setup();
    const diff = { added: 18, removed: 4 };
    await Promise.all([
      teams.editTasks(team.id, {
        operations: [{ type: "update", taskId: task.id, patch: { artifactId } }],
      }),
      teams.editTasks(team.id, {
        operations: [{ type: "update", taskId: task.id, patch: { diff } }],
      }),
    ]);
    expect((await teams.getTeam(team.id))?.tasks).toEqual([{ ...task, artifactId, diff }]);
  });

  test("out-of-team references reject replacements and roll back entire edit batches", async () => {
    const { teams, team: other, task, artifactId } = await setup();
    const team = await createStoredTeam(teams, { name: "Other", ...TEAM_DEFAULTS });
    await teams.updateTeam(team.id, { tasks: [task] });
    const before = await teams.getSnapshot(team.id, 100);
    for (const patch of [{ artifactId }, { ownerId: other.id }]) {
      await expect(teams.updateTeam(team.id, { tasks: [{ ...task, ...patch }] })).rejects.toThrow();
      await expect(
        teams.editTasks(team.id, {
          operations: [
            { type: "update", taskId: task.id, patch: { status: "done" } },
            { type: "update", taskId: task.id, patch },
          ],
        }),
      ).rejects.toThrow();
      expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
    }
  });

  test("stale references do not block progress or moves, but cannot be introduced or replaced wholesale", async () => {
    const { database, teams, team, task, artifactId } = await setup();
    const child = { ...task, id: "output", artifactId, ownerId: "former-member" };
    // Simulate references left behind by an external relocation or repair.
    await database`
      UPDATE teams SET tasks = ${JSON.stringify([{ ...task, children: [child] }])}
      WHERE id = ${team.id}
    `;
    await teams.editTasks(team.id, {
      operations: [
        { type: "update", taskId: task.id, patch: { status: "in_progress" } },
        { type: "move", taskId: child.id },
      ],
    });
    const tasks: TeamTask[] = [{ ...task, status: "in_progress", children: [] }, child];
    expect((await teams.getTeam(team.id))?.tasks).toEqual(tasks);
    await expect(teams.updateTeam(team.id, { tasks })).rejects.toThrow(
      "Task owners must be the team lead or a current member.",
    );
    const before = await teams.getSnapshot(team.id, 100);
    await expect(
      teams.editTasks(team.id, {
        operations: [
          { type: "update", taskId: task.id, patch: { status: "done" } },
          {
            type: "add",
            task: { ...task, id: "new-group", children: [{ ...child, id: "copy" }] },
          },
        ],
      }),
    ).rejects.toThrow("Task owners must be the team lead or a current member.");
    expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
    await teams.editTasks(team.id, {
      operations: [{ type: "update", taskId: child.id, patch: { ownerId: null } }],
    });
    expect((await teams.getTeam(team.id))?.tasks[1]).toEqual({
      ...task,
      id: child.id,
      artifactId,
    });
  });

  test("a relocated artifact blocks new links, not unrelated additions, and can be explicitly repaired", async () => {
    const { database, teams, team, task, artifactId } = await setup();
    await teams.updateTeam(team.id, { tasks: [{ ...task, artifactId }] });
    const relocated = machineFile("/relocated/review.md");
    const relocatedId = workspaceFileId(relocated);
    await database`UPDATE team_artifacts SET path = ${relocated.path} WHERE team_id = ${team.id}`;
    const added = { ...task, id: "next", artifactId: relocatedId };
    await teams.editTasks(team.id, { operations: [{ type: "add", task: added }] });
    const before = await teams.getSnapshot(team.id, 100);
    for (const patch of [{ artifactId }, { ownerId: "missing-member" }]) {
      await expect(
        teams.editTasks(team.id, {
          operations: [
            { type: "update", taskId: task.id, patch: { status: "done" } },
            { type: "update", taskId: added.id, patch },
          ],
        }),
      ).rejects.toThrow();
      expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
    }
    await expect(
      teams.updateTeam(team.id, { tasks: [{ ...task, artifactId }, added] }),
    ).rejects.toThrow('Task "t1" must reference an artifact shared in this team.');
    await teams.editTasks(team.id, {
      operations: [
        { type: "update", taskId: task.id, patch: { artifactId: relocatedId, status: "done" } },
      ],
    });
    expect((await teams.getTeam(team.id))?.tasks).toEqual([
      { ...task, artifactId: relocatedId, status: "done" },
      added,
    ]);
  });
});

describe("team database", () => {
  test("stores structural membership and an ordered transcript", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Release room",
      directory: "/workspace/project",
      ...TEAM_DEFAULTS,
    });
    expect((await teams.getSnapshot(team.id, 100))?.lead).toMatchObject({
      id: team.id,
      name: "Lead",
    });
    expect(await teams.listMembers(team.id)).toEqual([]);
    const critic = teamAgent(team.id, "critic-session", "Critic");
    const {
      member,
      events: [joinedEvent],
    } = await teams.createMember(critic);
    const joined = joinedEvent!.message;
    await createStoredTeam(teams, { name: "Another room", ...TEAM_DEFAULTS });

    const attachments = [
      "/workspace/screenshot.png",
      { mimeType: "image/png", base64: "aW1hZ2U=" },
    ];
    const { message: first } = await teams.appendMessage({
      id: "message-1",
      teamId: team.id,
      sender: { type: "user" },
      content: "@critic Please check the invitation flow.",
      attachments,
    });
    const second = await teams.appendMessage({
      id: "message-2",
      teamId: team.id,
      sender: {
        type: "agent",
        agentId: critic.sessionId,
      },
      content: "The empty state is clear.",
    });

    expect(first.sequence).toBe(2);
    expect(first.attachments).toEqual(attachments);
    expect(second.team).toEqual((await teams.getTeam(team.id))!);
    expect(await teams.listMembers(team.id)).toEqual([member]);
    expect((await teams.listTeams()).members).toEqual([member]);
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(3);
    const messages = await teams.listMessagesAfter(team.id);
    expect(messages.slice(0, 2)).toEqual([joined, first]);
    expect(messages.map(({ sender, content }) => ({ sender, content }))).toEqual([
      {
        sender: { type: "system" },
        content: { type: "member_joined", member },
      },
      {
        sender: { type: "user" },
        content: "@critic Please check the invitation flow.",
      },
      {
        sender: { type: "agent", agentId: critic.sessionId },
        content: "The empty state is clear.",
      },
    ]);
    expect(
      (await teams.listMessagesBefore(team.id, undefined, 2)).map(({ sequence }) => sequence),
    ).toEqual([2, 3]);
    expect((await teams.listMessagesBefore(team.id, 3, 2)).map(({ sequence }) => sequence)).toEqual(
      [1, 2],
    );
  });

  test("serializes concurrent writers on the shared SQLite connection", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Concurrent room",
      ...TEAM_DEFAULTS,
    });

    const changes = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        teams.appendMessage({
          id: `message-${index + 1}`,
          teamId: team.id,
          sender: { type: "user" },
          content: `Concurrent message ${index + 1}`,
        }),
      ),
    );

    const expectedSequences = Array.from({ length: 12 }, (_, index) => index + 1);
    expect(changes.map(({ message }) => message.sequence)).toEqual(expectedSequences);
    expect(changes.flatMap(({ events }) => events.map(({ revision }) => revision))).toEqual(
      expectedSequences,
    );
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(12);
    expect((await teams.listMessagesAfter(team.id)).map(({ sequence }) => sequence)).toEqual(
      expectedSequences,
    );
  });

  test("sets and clears one reaction per Agent without changing Team metadata", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Reaction room",
      ...TEAM_DEFAULTS,
    });
    const reviewerId = "reviewer-session";
    const designerId = "designer-session";
    await teams.appendMessage({
      id: "message-1",
      teamId: team.id,
      sender: { type: "user" },
      content: "The direction is approved.",
    });
    const teamBeforeReactions = await teams.getTeam(team.id);

    await Promise.all([
      teams.setMessageReaction({
        teamId: team.id,
        sequence: 1,
        agentId: reviewerId,
        reaction: "love",
      }),
      teams.setMessageReaction({
        teamId: team.id,
        sequence: 1,
        agentId: designerId,
        reaction: "done",
      }),
    ]);
    await teams.setMessageReaction({
      teamId: team.id,
      sequence: 1,
      agentId: reviewerId,
      reaction: "agree",
    });

    const reactions = (await teams.listMessagesAfter(team.id))[0]?.reactions;
    expect(reactions).toHaveLength(2);
    expect(reactions).toEqual(
      expect.arrayContaining([
        { agentId: designerId, reaction: "done" },
        { agentId: reviewerId, reaction: "agree" },
      ]),
    );
    await teams.setMessageReaction({
      teamId: team.id,
      sequence: 1,
      agentId: reviewerId,
      reaction: null,
    });
    await teams.setMessageReaction({
      teamId: team.id,
      sequence: 1,
      agentId: reviewerId,
      reaction: null,
    });
    expect((await teams.listMessagesAfter(team.id))[0]?.reactions).toEqual([
      { agentId: designerId, reaction: "done" },
    ]);
    expect(await teams.getTeam(team.id)).toEqual(teamBeforeReactions);
  });

  test("tracks independent, monotonic human and Agent read positions", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Planning", ...TEAM_DEFAULTS });
    const { member } = await teams.createMember(teamAgent(team.id, "planner-session", "Planner"));
    await teams.appendMessage({
      id: "message-1",
      teamId: team.id,
      sender: { type: "user" },
      content: "Start with the risks.",
    });

    await teams.markAgentSeen(member.id, 2);
    expect((await teams.getMember("planner-session"))?.seenThrough).toBe(2);
    expect((await teams.getTeam(team.id))?.seenThrough).toBe(0);
    expect(await teams.markUserSeen(team.id, 100)).toMatchObject({
      events: [{ type: "read", revision: 3, seenThrough: 2 }],
    });
    expect((await teams.getTeam(team.id))?.seenThrough).toBe(2);
    await teams.markAgentSeen(member.id, 1);
    expect(await teams.markUserSeen(team.id, 1)).toBeNull();
    expect((await teams.getRoster(team.id))?.revision).toBe(3);
    expect((await teams.getMember(member.id))?.seenThrough).toBe(2);
    expect((await teams.getTeam(team.id))?.seenThrough).toBe(2);

    await teams.appendMessage({
      id: "message-2",
      teamId: team.id,
      sender: { type: "user" },
      content: "Then propose mitigations.",
    });
    expect((await teams.getMember("planner-session"))?.seenThrough).toBe(2);
  });

  test("member edits update the roster without messages and preserve collaboration state", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Profile room",
      ...TEAM_DEFAULTS,
    });
    const { member } = await teams.createMember(teamAgent(team.id, "critic-session", "Critic"));
    const status = { state: "working", text: "Reviewing the direction", workingOn: 1 } as const;
    await teams.markAgentSeen(member.id, 1);
    await teams.setAgentStatus(member.id, status);

    const model = { provider: "copilot", name: "gpt-6", reasoningEffort: "high" };
    const change = await teams.updateMember(member.id, {
      name: "Critic Revised",
      role: "Tests product decisions against user needs.",
      model,
    });

    expect(change).toMatchObject({
      member: {
        name: "Critic Revised",
        role: "Tests product decisions against user needs.",
        model,
        status,
      },
    });
    expect(await teams.getMember(member.id)).toMatchObject({
      name: "Critic Revised",
      model,
      seenThrough: 1,
      status,
    });
    expect((await teams.listTeams()).members).toEqual([
      { id: change.member.id, teamId: team.id, name: "Critic Revised" },
    ]);
    expect((await teams.listMessagesAfter(team.id)).map(({ content }) => content)).toEqual([
      { type: "member_joined", member },
    ]);
    const revision = (await teams.getRoster(team.id))?.revision;
    expect(
      await teams.updateMember(member.id, {
        name: "Critic Revised",
        role: "Tests product decisions against user needs.",
        model: { reasoningEffort: "high", name: "gpt-6", provider: "copilot" },
      }),
    ).toEqual({ teamId: team.id, events: [], member: change.member });
    expect((await teams.getRoster(team.id))?.revision).toBe(revision);

    const inherited = await teams.updateMember(member.id, { model: null });
    expect(inherited.member.model).toBeUndefined();
    expect(inherited.member.role).toBe(change.member.role);
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(1);
  });

  test("rejects a conflicting mention handle without changing the member or team", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Review", ...TEAM_DEFAULTS });
    await teams.createMember(teamAgent(team.id, "reviewer", "Reviewer"));
    const { member } = await teams.createMember(teamAgent(team.id, "builder", "Builder"));
    const before = await teams.getSnapshot(team.id, 100);

    await expect(
      teams.updateMember(member.id, { name: "Reviewer", role: "New role" }),
    ).rejects.toThrow("already uses the @reviewer mention");

    expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
  });

  test("treats equivalent status values as unchanged", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Status room",
      ...TEAM_DEFAULTS,
    });
    const { member } = await teams.createMember(teamAgent(team.id, "critic-session", "Critic"));
    await teams.setAgentStatus(member.id, {
      state: "working",
      text: "Reviewing the direction",
      workingOn: 1,
    });

    expect(
      await teams.setAgentStatus(member.id, {
        workingOn: 1,
        text: "Reviewing the direction",
        state: "working",
      }),
    ).toBeNull();
  });

  test("records metadata and preview messages while task revisions remain quiet", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Progress room",
      ...TEAM_DEFAULTS,
    });
    const { member } = await teams.createMember(teamAgent(team.id, "builder-session", "Builder"));
    const revision = (await teams.getRoster(team.id))?.revision;

    const update = await teams.updateTeam(team.id, {
      name: "Delivery room",
      purpose: "Ship and validate the product.",
      directory: "/workspace/delivery",
      tasks: [
        {
          id: "build",
          title: "Build the product",
          status: "in_progress",
          ownerId: member.id,
          children: [{ id: "verify", title: "Verify the preview", status: "pending" }],
        },
      ],
      preview: { kind: "url", url: "http://127.0.0.1:3000" },
    });

    const actor = { type: "agent", agentId: team.id } as const;
    const messages = update.events.filter((event) => event.type === "message");
    expect(messages.map(({ message }) => message.content)).toEqual([
      { type: "team_renamed", actor, name: "Delivery room" },
      { type: "team_purpose_changed", actor, purpose: "Ship and validate the product." },
      { type: "team_directory_changed", actor, directory: "/workspace/delivery" },
      { type: "preview_changed", actor, preview: { kind: "url", url: "http://127.0.0.1:3000" } },
    ]);
    expect(messages.map(({ message }) => message.sequence)).toEqual([2, 3, 4, 5]);
    expect(update.events[0]).toEqual({
      type: "tasks",
      revision: revision! + 1,
      tasks: update.team.tasks,
    });
    expect(messages.map(({ revision }) => revision)).toEqual(
      [2, 3, 4, 5].map((offset) => revision! + offset),
    );
    expect((await teams.getRoster(team.id))?.revision).toBe(revision! + 5);
    expect(await teams.getTeam(team.id)).toEqual(update.team);
    const cleared = await teams.updateTeam(team.id, { preview: null });
    expect(cleared.events).toMatchObject([
      {
        type: "message",
        revision: revision! + 6,
        message: { content: { type: "preview_changed", actor, preview: null } },
      },
    ]);
    expect(cleared.team.preview).toBeUndefined();
    expect(await teams.getTeam(team.id)).toEqual(cleared.team);
    expect((await teams.updateTeam(team.id, { purpose: null })).team.purpose).toBeUndefined();
    expect((await teams.listMessagesAfter(team.id)).at(-1)?.content).toEqual({
      type: "team_purpose_changed",
      actor: { type: "agent", agentId: team.id },
      purpose: null,
    });
    await expect(
      teams.updateTeam(member.id, {
        tasks: [{ id: "take-over", title: "Take over", status: "pending" }],
      }),
    ).rejects.toThrow("Only the team lead");
    await expect(
      teams.editTasks(member.id, {
        operations: [{ type: "update", taskId: "build", patch: { status: "done" } }],
      }),
    ).rejects.toThrow("Only the team lead");

    await teams.deleteMember(member.id);
    expect((await teams.getTeam(team.id))?.tasks).toEqual([
      {
        id: "build",
        title: "Build the product",
        status: "in_progress",
        children: [{ id: "verify", title: "Verify the preview", status: "pending" }],
      },
    ]);
  });

  test("a screen preview persists as one idempotent reference and can be replaced by a URL", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Screen room",
      ...TEAM_DEFAULTS,
    });
    const preview = { kind: "screen", screenId: "live-window" } as const;
    const published = await teams.updateTeam(team.id, { preview });
    expect((await teams.getTeam(team.id))?.preview).toEqual(preview);
    expect(published.events).toMatchObject([
      { type: "message", message: { content: { type: "preview_changed", preview } } },
    ]);
    expect((await teams.updateTeam(team.id, { preview: { ...preview } })).events).toEqual([]);
    const replaced = await teams.updateTeam(team.id, {
      preview: { kind: "url", url: "/app" },
    });
    expect(replaced.team.preview).toEqual({ kind: "url", url: "/app" });
    expect((await teams.listMessagesAfter(team.id))[0]?.content).toMatchObject({ preview });
  });

  test("a canvas is one durable, idempotent shared app reference", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Canvas", ...TEAM_DEFAULTS });
    const actor = { type: "agent", agentId: team.id } as const;
    const files = [sessionFile(team.id, "board.toy"), sessionFile(team.id, "metrics.toy")];
    for (const file of files) {
      await teams.shareArtifact({ teamId: team.id, file, title: file.path, actor });
    }
    const firstId = workspaceFileId(files[0]!);
    const secondId = workspaceFileId(files[1]!);
    const selected = await teams.updateTeam(team.id, { canvasArtifactId: firstId });
    expect(selected.events).toMatchObject([
      {
        type: "message",
        message: { content: { type: "canvas_changed", actor, canvasArtifactId: firstId } },
      },
    ]);
    expect((await teams.getTeam(team.id))?.canvasArtifactId).toBe(firstId);
    expect((await teams.listTeams()).teams[0]?.canvasArtifactId).toBe(firstId);
    expect((await teams.getSnapshot(team.id, 100))?.team.canvasArtifactId).toBe(firstId);
    expect((await teams.updateTeam(team.id, { canvasArtifactId: firstId })).events).toEqual([]);
    const replaced = await teams.updateTeam(team.id, { canvasArtifactId: secondId });
    expect(replaced.team.canvasArtifactId).toBe(secondId);
    const cleared = await teams.updateTeam(team.id, { canvasArtifactId: null });
    expect(cleared.events).toMatchObject([
      { type: "message", message: { content: { type: "canvas_changed", canvasArtifactId: null } } },
    ]);
    expect((await teams.getTeam(team.id))?.canvasArtifactId).toBeUndefined();
    expect(await teams.listArtifacts(team.id)).toHaveLength(2);
  });

  test("invalid canvas selections roll back the whole team update", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Canvas", ...TEAM_DEFAULTS });
    const other = await createStoredTeam(teams, { name: "Other", ...TEAM_DEFAULTS });
    const files = [
      machineFile("/workspace/board.toy"),
      sessionFile(team.id, "notes.md"),
      sessionFile(other.id, "private.toy"),
    ];
    for (const file of files) {
      await teams.shareArtifact({
        teamId: file === files[2] ? other.id : team.id,
        file,
        title: file.path,
        actor: { type: "user" },
      });
    }
    const before = await teams.getSnapshot(team.id, 100);
    for (const canvasArtifactId of ["missing", ...files.map(workspaceFileId)]) {
      await expect(
        teams.updateTeam(team.id, { name: "Rejected", canvasArtifactId }),
      ).rejects.toThrow("shared session-owned .toy app");
      expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
    }
  });

  test("only the lead selects the canvas", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Canvas", ...TEAM_DEFAULTS });
    const { member } = await teams.createMember(teamAgent(team.id, "builder", "Builder"));
    await expect(teams.updateTeam(member.id, { canvasArtifactId: null })).rejects.toThrow(
      "Only the team lead",
    );
    expect((await teams.getTeam(team.id))?.canvasArtifactId).toBeUndefined();
  });

  test("rejecting a provider change leaves all team fields unchanged", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Planning", ...TEAM_DEFAULTS });
    await expect(
      teams.editTeam({
        teamId: team.id,
        name: "Rejected name",
        model: { provider: "codex", name: "gpt-6" },
      }),
    ).rejects.toThrow("provider cannot change");
    expect(await teams.getTeam(team.id)).toEqual(team);
  });

  test("changing only the lead model does not create unread team activity", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Planning", ...TEAM_DEFAULTS });

    const change = await teams.editTeam({
      teamId: team.id,
      model: { provider: "copilot", name: "gpt-6" },
    });

    expect(change).toMatchObject({ team: { latestSequence: 0 } });
    expect(change.team.updatedAt).not.toBe(team.updatedAt);
    expect(change.events).toEqual([
      {
        type: "model",
        revision: 1,
        model: change.team.model,
        updatedAt: change.team.updatedAt,
      },
    ]);
    expect((await teams.getRoster(team.id))?.revision).toBe(1);
    expect(await teams.getTeam(team.id)).toEqual(change.team);
    expect(await teams.listMessagesAfter(team.id)).toEqual([]);
  });

  test("does not repeat unchanged artifact shares", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Artifacts", ...TEAM_DEFAULTS });
    await teams.shareArtifact({
      teamId: team.id,
      file: machineFile("/workspace/plan.md"),
      title: "Implementation plan",
      actor: { type: "user" },
    });
    await teams.shareArtifact({
      teamId: team.id,
      file: machineFile("/workspace/plan.md"),
      title: "Release plan",
      actor: { type: "user" },
    });
    const revision = (await teams.getRoster(team.id))?.revision;
    await teams.shareArtifact({
      teamId: team.id,
      file: machineFile("/workspace/plan.md"),
      title: "Release plan",
      actor: { type: "user" },
    });
    expect((await teams.getRoster(team.id))?.revision).toBe(revision);
    await teams.shareArtifact({
      teamId: team.id,
      file: sessionFile("designer-session", "plan.md"),
      title: "Design plan",
      actor: { type: "user" },
    });

    expect(await teams.listArtifacts(team.id)).toEqual([
      {
        id: "session:designer-session:plan.md",
        file: sessionFile("designer-session", "plan.md"),
        title: "Design plan",
        sharedAt: expect.any(String),
      },
      {
        id: "machine:/workspace/plan.md",
        file: machineFile("/workspace/plan.md"),
        title: "Release plan",
        sharedAt: expect.any(String),
      },
    ]);
    expect((await teams.getSnapshot(team.id, 100))?.messages).toHaveLength(3);
  });

  test("the user's artifact arrangement is durable, quiet, and new shares come first", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Artifacts", ...TEAM_DEFAULTS });
    const share = (path: string) =>
      teams.shareArtifact({
        teamId: team.id,
        file: machineFile(path),
        title: path,
        actor: { type: "user" },
      });
    const titles = async () =>
      (await teams.listArtifacts(team.id)).map(({ title, archived }) =>
        archived ? `${title} (archived)` : title,
      );
    for (const path of ["/plan.md", "/spec.md", "/notes.md"]) await share(path);
    expect(await titles()).toEqual(["/notes.md", "/spec.md", "/plan.md"]);
    const { latestSequence } = (await teams.getTeam(team.id))!;
    const revision = (await teams.getRoster(team.id))!.revision;

    const moved = await teams.arrangeArtifacts({
      teamId: team.id,
      artifactIds: ["machine:/plan.md"],
      beforeArtifactId: "machine:/notes.md",
    });
    expect(moved.events).toEqual([
      {
        type: "artifacts",
        revision: revision + 1,
        artifacts: await teams.listArtifacts(team.id),
      },
    ]);
    await teams.arrangeArtifacts({
      teamId: team.id,
      artifactIds: ["machine:/spec.md"],
      archived: true,
    });
    expect(await titles()).toEqual(["/plan.md", "/notes.md", "/spec.md (archived)"]);
    expect(
      (
        await teams.arrangeArtifacts({
          teamId: team.id,
          artifactIds: ["machine:/notes.md"],
          beforeArtifactId: "machine:/spec.md",
          archived: false,
        })
      ).events,
    ).toEqual([]);

    await share("/review.md");
    await share("/plan.md");
    expect(await titles()).toEqual(["/review.md", "/plan.md", "/notes.md", "/spec.md (archived)"]);
    // A set moves together in the given order and archives in one revision.
    const bulk = await teams.arrangeArtifacts({
      teamId: team.id,
      artifactIds: ["machine:/notes.md", "machine:/review.md"],
      beforeArtifactId: null,
      archived: true,
    });
    expect(bulk.events).toHaveLength(1);
    expect(await titles()).toEqual([
      "/plan.md",
      "/spec.md (archived)",
      "/notes.md (archived)",
      "/review.md (archived)",
    ]);
    expect((await teams.getSnapshot(team.id, 100))?.artifacts).toEqual(
      await teams.listArtifacts(team.id),
    );
    // Arranging stays out of the transcript and catalog activity; only the share adds a message.
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(latestSequence + 1);
  });

  test("arranging an artifact the team hasn't shared changes nothing", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Artifacts", ...TEAM_DEFAULTS });
    await teams.shareArtifact({
      teamId: team.id,
      file: machineFile("/plan.md"),
      title: "Plan",
      actor: { type: "user" },
    });

    const before = await teams.getSnapshot(team.id, 100);
    for (const arrangement of [
      { artifactIds: ["machine:/plan.md", "machine:/missing.md"], archived: true },
      { artifactIds: ["machine:/plan.md"], beforeArtifactId: "machine:/missing.md" },
    ]) {
      await expect(teams.arrangeArtifacts({ teamId: team.id, ...arrangement })).rejects.toThrow(
        "Arrange artifacts shared in this team.",
      );
    }
    expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
  });

  test("pins persist across reads and new shares, and archiving clears them", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Pins", ...TEAM_DEFAULTS });
    const share = (path: string) =>
      teams.shareArtifact({
        teamId: team.id,
        file: machineFile(path),
        title: path,
        actor: { type: "user" },
      });
    await share("/plan.md");
    await share("/spec.md");
    const pin = (path: string) =>
      teams.arrangeArtifacts({
        teamId: team.id,
        artifactIds: [`machine:${path}`],
        pinned: true,
      });
    await pin("/plan.md");
    await pin("/spec.md");
    expect((await pin("/plan.md")).events).toEqual([]);
    await share("/new.md");
    await share("/plan.md");
    const snapshot = await teams.getSnapshot(team.id, 100);
    expect(snapshot?.artifacts).toMatchObject([
      { title: "/plan.md", pinned: true },
      { title: "/spec.md", pinned: true },
      { title: "/new.md" },
    ]);
    await teams.arrangeArtifacts({
      teamId: team.id,
      artifactIds: ["machine:/plan.md"],
      archived: true,
    });
    const archived = (await teams.listArtifacts(team.id)).find(({ title }) => title === "/plan.md");
    expect(archived?.archived).toBe(true);
    expect(archived?.pinned).toBeUndefined();
  });

  test("deleting a member retains sender attribution in prior messages", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, {
      name: "Durable log",
      ...TEAM_DEFAULTS,
    });
    const { member } = await teams.createMember(teamAgent(team.id, "reviewer-session", "Reviewer"));
    await teams.appendMessage({
      id: "message-1",
      teamId: team.id,
      sender: {
        type: "agent",
        agentId: member.id,
      },
      content: "The contract is coherent.",
    });

    expect(await teams.deleteMember(member.id)).toMatchObject({
      member: { id: member.id, name: "Reviewer" },
    });
    const messages = await teams.listMessagesAfter(team.id);
    expect(messages.find(({ id }) => id === "message-1")?.sender).toEqual({
      type: "agent",
      agentId: member.id,
    });
    expect(messages.at(-1)?.content).toEqual({ type: "member_left", member });
  });
});

describe("team routines", () => {
  async function setup() {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Watch", ...TEAM_DEFAULTS });
    return { teams, team };
  }

  /** A local wall-clock time, so hourly cron boundaries hold in any time zone. */
  function localTime(hours: number, minutes = 0): Date {
    return new Date(2026, 8, 29, hours, minutes);
  }

  test("a lead adds, changes, and deletes routines with one transcript message each", async () => {
    const { teams, team } = await setup();
    const standup = await teams.setRoutine(team.id, {
      title: "CI",
      schedule: "0 9 * * 1-5",
      prompt: "Check CI",
    });
    const review = await teams.setRoutine(team.id, {
      title: "Review",
      schedule: "0 16 * * 5",
      prompt: "Review the week",
    });
    const changed = await teams.setRoutine(team.id, {
      routineId: standup.routine.id,
      title: "CI",
      schedule: "0 9 * * 1-5",
      prompt: "Check CI and new issues",
    });
    await teams.deleteRoutine(team.id, review.routine.id);

    expect((await teams.listMessagesAfter(team.id)).map(({ content }) => content)).toEqual([
      { type: "routine_scheduled", routine: standup.routine },
      { type: "routine_scheduled", routine: review.routine },
      { type: "routine_edited", routine: changed.routine },
      { type: "routine_deleted", routine: review.routine },
    ]);
    expect((await teams.getSnapshot(team.id, 100))?.routines).toEqual([changed.routine]);
  });

  test("an identical change and a repeated deletion leave the transcript alone", async () => {
    const { teams, team } = await setup();
    const input = { title: "CI", schedule: "0 9 * * *", prompt: "Check CI" };
    const { routine } = await teams.setRoutine(team.id, input);
    const unchanged = await teams.setRoutine(team.id, { routineId: routine.id, ...input });
    await teams.deleteRoutine(team.id, routine.id);

    expect(unchanged.events).toEqual([]);
    expect(await teams.deleteRoutine(team.id, routine.id)).toBeNull();
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(2);
  });

  test("routine edits require the team lead and an existing routine", async () => {
    const { teams, team } = await setup();
    const { member } = await teams.createMember(teamAgent(team.id, "watcher", "Watcher"));
    const routine = { title: "CI", schedule: "0 9 * * *", prompt: "Check CI" };

    await expect(teams.setRoutine(member.id, routine)).rejects.toThrow("Only the team lead");
    await expect(teams.setRoutine(team.id, { ...routine, routineId: "missing" })).rejects.toThrow(
      "Routine not found",
    );
  });

  test("a due routine is claimed once, and runs missed while stopped collapse into one", async () => {
    const { teams, team } = await setup();
    setSystemTime(localTime(10, 30));
    onTestFinished(() => setSystemTime());
    await teams.setRoutine(team.id, {
      title: "CI",
      schedule: "0 * * * *",
      prompt: "Check CI",
    });
    const due = [{ teamId: team.id, title: "CI", prompt: "Check CI" }];

    expect((await teams.claimDueWakes(localTime(10, 59))).routines).toEqual([]);
    expect((await teams.claimDueWakes(localTime(14, 10))).routines).toEqual(due);
    expect((await teams.claimDueWakes(localTime(14, 10))).routines).toEqual([]);
    expect((await teams.claimDueWakes(localTime(15))).routines).toEqual(due);
  });

  test("pause persists, retains schedules and follow-ups, and excludes only paused teams from claims", async () => {
    const { teams, team } = await setup();
    const other = await createStoredTeam(teams, { name: "Active", ...TEAM_DEFAULTS });
    setSystemTime(localTime(10, 30));
    onTestFinished(() => setSystemTime());
    const input = { title: "CI", schedule: "0 * * * *", prompt: "Check CI" };
    const { routine } = await teams.setRoutine(team.id, input);
    await teams.setRoutine(other.id, input);
    const status = { state: "waiting" as const, text: "CI", wakeAt: localTime(11).toISOString() };
    await teams.setAgentStatus(team.id, status, false);

    const change = await teams.editTeam({ teamId: team.id, paused: true });
    expect(change.team.paused).toBe(true);
    expect((await teams.getSnapshot(team.id, 100))?.team.paused).toBe(true);
    expect((await teams.listTeams()).teams.find(({ id }) => id === team.id)?.paused).toBe(true);
    expect((await teams.editTeam({ teamId: team.id, paused: true })).events).toEqual([]);
    expect(await teams.listRoutines(team.id)).toEqual([routine]);
    await expect(teams.createMember(teamAgent(team.id, "late", "Late"))).rejects.toThrow(
      "Resume the team",
    );
    const due = await teams.claimDueWakes(localTime(14, 10));
    expect(due.followUps).toEqual([]);
    expect(due.routines).toEqual([{ teamId: other.id, title: "CI", prompt: "Check CI" }]);
    expect((await teams.getAgent(team.id))?.status).toEqual(status);

    await teams.editTeam({ teamId: team.id, paused: false });
    const resumed = await teams.claimDueWakes(localTime(14, 10));
    expect(resumed.followUps.map(({ agentId }) => agentId)).toEqual([team.id]);
    expect(resumed.routines).toEqual([{ teamId: team.id, title: "CI", prompt: "Check CI" }]);
    expect(await teams.claimDueWakes(localTime(14, 10))).toEqual({
      followUps: [],
      routines: [],
    });
  });
});
