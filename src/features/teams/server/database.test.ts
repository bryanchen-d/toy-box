import { teamAgent, createStoredTeam } from "@teams/server/testFixtures";
import { describe, expect, onTestFinished, setSystemTime, test } from "bun:test";
import type { EditTeamTasksInput, TeamEvent } from "@teams/model";
import { machineFile, sessionFile, workspaceFileId } from "@files/model";
import { createTestDatabase } from "@/server/database";
import { TeamDatabase } from "./database";

const TEAM_DEFAULTS = {
  purpose: "Coordinate the work to a useful result.",
  model: { provider: "copilot", name: "gpt-5.5" },
} as const;

/** The event that records the task list becoming complete. */
function isCompletion<Event extends TeamEvent<unknown>>(
  event: Event,
): event is Extract<Event, { type: "message" }> {
  return (
    event.type === "message" &&
    typeof event.message.content === "object" &&
    event.message.content.type === "tasks_completed"
  );
}

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

  test("a task leads to the newest conversation message citing its whole ID", async () => {
    const { teams, team, post } = await setup();
    const root = await post("Starting t1 now", { user: true });
    const reply = await post("t1 is ready for review", { threadSequence: root.sequence });
    await post("t12 is next");
    await teams.updateTeam(team.id, { purpose: "Ship t1" });
    expect(await teams.findTaskMessage(team.id, "t1")).toEqual({
      sequence: reply.sequence,
      threadSequence: root.sequence,
    });
    expect(await teams.findTaskMessage(team.id, "t9")).toBeNull();
    await expect(teams.findTaskMessage("missing", "t1")).rejects.toThrow("Team not found");
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
    /** Reopens the list's one task, then completes it, returning the completion message. */
    const complete = async () => {
      const [existing] = await teams.listTasks(team.id);
      const taskId =
        existing?.id ??
        (await teams.editTasks(team.id, { operations: [{ type: "add", title: "Release" }] }))
          .opened[0]!.id;
      await edit([{ type: "update", taskId, patch: { status: "in_progress" } }]);
      const { events } = await edit([{ type: "update", taskId, patch: { status: "completed" } }]);
      return events.filter(isCompletion)[0]!.message;
    };
    const edit = (operations: EditTeamTasksInput["operations"]) =>
      teams.editTasks(team.id, { operations });
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
    return { teams, team, post, complete, ask, edit };
  }

  test("completion follows the list becoming complete: every task closed, one completed", async () => {
    const { teams, team, edit } = await setup();
    const completions = async (operations: EditTeamTasksInput["operations"]) =>
      (await edit(operations)).events.filter(isCompletion);
    expect(await completions([{ type: "add", title: "Release" }])).toEqual([]);
    const [completed] = await completions([
      { type: "update", taskId: "t1", patch: { status: "completed" } },
    ]);
    expect((await teams.getTeam(team.id))?.completedSequence).toBe(completed!.message.sequence);
    expect(await completions([{ type: "update", taskId: "t1", patch: { title: "Ship" } }])).toEqual(
      [],
    );
    expect(await completions([{ type: "add", title: "Notes" }])).toEqual([]);
    expect(
      await completions([{ type: "update", taskId: "t2", patch: { status: "cancelled" } }]),
    ).toHaveLength(1);
    expect(await completions([{ type: "remove", taskId: "t1" }])).toEqual([]);
    expect(await completions([{ type: "remove", taskId: "t2" }])).toEqual([]);
  });

  test("only messages that involve the user mark the team unread", async () => {
    const { teams, team, edit } = await setup();
    const lead = { type: "agent", agentId: team.id } as const;
    const send = async (
      content: string,
      options: { thread?: number; user?: true; request?: true } = {},
    ) => {
      const { events, team: after } = await teams.appendMessage({
        id: crypto.randomUUID(),
        teamId: team.id,
        sender: options.user ? { type: "user" } : lead,
        content,
        ...(options.thread ? { threadSequence: options.thread } : {}),
        ...(options.request ? { request: true } : {}),
      });
      return { sequence: events[0]!.message.sequence, attention: after.attentionSequence };
    };
    const topLevel = await send("Kickoff");
    expect(topLevel.attention).toBe(topLevel.sequence);
    // Agents talking in their own thread, or working in a task's, leave it read.
    expect((await send("Working on it", { thread: topLevel.sequence })).attention).toBe(
      topLevel.sequence,
    );
    const { opened } = await edit([{ type: "add", title: "Parser" }]);
    const opening = opened[0]!.threadSequence!;
    expect((await teams.getTeam(team.id))?.attentionSequence).toBe(opening);
    await edit([{ type: "update", taskId: "t1", patch: { title: "Lexer" }, note: "Renamed." }]);
    expect((await teams.getTeam(team.id))?.attentionSequence).toBe(opening);
    // A question, the user's own reply, and replies in a thread the user posted in involve them.
    const question = await send("Which grammar?", { thread: opening, request: true });
    expect(question.attention).toBe(question.sequence);
    const answer = await send("PEG.", { thread: opening, user: true });
    expect(answer.attention).toBe(answer.sequence);
    const followUp = await send("On it.", { thread: opening });
    expect(followUp.attention).toBe(followUp.sequence);
    expect((await teams.getTeam(team.id))?.attentionSequence).toBe(followUp.sequence);
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
    const done = await complete();
    const question = await ask("What should we do next?");
    for (let index = 0; index < 105; index++) await post(`Update ${index}`);
    const snapshot = await teams.getSnapshot(team.id, 100);
    expect(snapshot?.messages).toHaveLength(100);
    expect(snapshot?.request).toMatchObject({ content: "What should we do next?" });
    expect((await teams.listTeams()).teams[0]).toMatchObject({
      completedSequence: done.sequence,
      requestSequence: question.sequence,
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
      (await teams.listMessagesAfter(team.id)).filter(
        ({ sender, content }) =>
          sender.type === "system" && typeof content === "object" && content.type !== "task_opened",
      ),
    ).toEqual([done]);
  });

  test("only the lead resolves pending requests, and only when one is pending", async () => {
    const { teams, team, ask } = await setup();
    expect((await teams.resolveRequests(team.id)).events).toEqual([]);
    await ask("Which region?");
    await expect(teams.resolveRequests(crypto.randomUUID())).rejects.toThrow("team lead");
    const resolved = await teams.resolveRequests(team.id);
    expect(resolved).toMatchObject({
      team: { requestSequence: null },
      events: [{ type: "message", message: { content: { type: "requests_resolved" } } }],
    });
    expect(resolved.team).toEqual((await teams.getTeam(team.id))!);
    expect((await teams.getSnapshot(team.id, 1))?.request).toBeNull();
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

  test("only a user or agent message, or a task's opening note, in the same team starts a thread", async () => {
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
        "Reply to a user or agent message, or a task's thread, in this team.",
      );
    }
    expect((await teams.getTeam(team.id))?.latestSequence).toBe(latest);
    const [task] = (
      await teams.editTasks(team.id, { operations: [{ type: "add", title: "Ship" }] })
    ).opened;
    const reply = await post("On it.", task!.threadSequence);
    expect(reply.threadSequence).toBe(task!.threadSequence);
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
    const file = machineFile("/workspace/review.md");
    await teams.shareArtifact({
      teamId: team.id,
      file,
      title: "Review findings",
      actor: { type: "agent", agentId: team.id },
    });
    const edit = (operations: EditTeamTasksInput["operations"]) =>
      teams.editTasks(team.id, { operations });
    const [task] = (await edit([{ type: "add", title: "Review" }])).opened;
    return { database, teams, team, task: task!, edit, artifactId: workspaceFileId(file) };
  }

  test("each changed task publishes one event, and snapshots read the rows back", async () => {
    const { teams, team, task, edit } = await setup();
    const revision = (await teams.getRoster(team.id))!.revision;
    const { opened, events } = await edit([
      { type: "add", parentId: task.id, title: "Draft", children: [{ title: "Outline" }] },
      { type: "update", taskId: task.id, patch: { status: "in_progress", priority: "high" } },
    ]);
    const tasks = await teams.listTasks(team.id);
    expect(tasks.map(({ id, parentId }) => [id, parentId])).toEqual([
      ["t1", undefined],
      ["t2", "t1"],
      ["t3", "t2"],
    ]);
    expect(opened).toEqual(tasks.slice(1));
    const lead = { type: "agent", agentId: team.id };
    expect(events.slice(0, 2)).toMatchObject([
      {
        revision: revision + 1,
        message: { content: { type: "task_opened", taskId: "t2", actor: lead } },
      },
      {
        revision: revision + 2,
        message: { content: { type: "task_opened", taskId: "t3", actor: lead } },
      },
    ]);
    expect(events.slice(2)).toEqual(
      tasks.map((task, index) => ({ type: "task", task, revision: revision + 3 + index })),
    );
    expect(tasks[0]).toMatchObject({ status: "in_progress", priority: "high" });
    expect((await teams.getSnapshot(team.id, 100))?.tasks).toEqual(tasks);
    const removed = await edit([{ type: "remove", taskId: "t2" }]);
    expect(removed.events).toEqual([
      { type: "task_removed", taskId: "t3", revision: revision + 6 },
      { type: "task_removed", taskId: "t2", revision: revision + 7 },
    ]);
    expect(await teams.listTasks(team.id)).toEqual([tasks[0]!]);
  });

  test("numbers are never reused, even after removing the newest task", async () => {
    const { teams, team, edit } = await setup();
    await edit([{ type: "add", title: "Mistake" }]);
    await edit([{ type: "remove", taskId: "t2" }]);
    const { opened } = await edit([{ type: "add", title: "Real work" }]);
    expect(opened.map(({ id }) => id)).toEqual(["t3"]);
    await expect(
      edit([
        { type: "add", title: "Rolled back" },
        { type: "update", taskId: "missing", patch: { status: "completed" } },
      ]),
    ).rejects.toThrow("not found");
    expect((await edit([{ type: "add", title: "Next" }])).opened[0]?.id).toBe("t4");
    expect((await teams.listTasks(team.id)).map(({ id }) => id)).toEqual(["t1", "t3", "t4"]);
  });

  test("only the final batch state can advance revision or complete the list", async () => {
    const { teams, team, task, edit } = await setup();
    const before = await teams.getSnapshot(team.id, 100);
    expect(
      (
        await edit([
          { type: "update", taskId: task.id, patch: { status: "completed" } },
          { type: "update", taskId: task.id, patch: { status: "pending" } },
        ])
      ).events,
    ).toEqual([]);
    expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
  });

  test("serialized field edits preserve concurrent outcomes on the same task", async () => {
    const { teams, team, task, edit, artifactId } = await setup();
    const diff = { added: 18, removed: 4 };
    await Promise.all([
      edit([{ type: "update", taskId: task.id, patch: { artifactId } }]),
      edit([{ type: "update", taskId: task.id, patch: { diff } }]),
    ]);
    expect(await teams.listTasks(team.id)).toEqual([
      { ...task, artifactId, diff, updatedAt: expect.any(String) },
    ]);
  });

  test("out-of-team references roll back entire edit batches", async () => {
    const { teams, team: other, artifactId } = await setup();
    const team = await createStoredTeam(teams, { name: "Other", ...TEAM_DEFAULTS });
    const edit = (operations: EditTeamTasksInput["operations"]) =>
      teams.editTasks(team.id, { operations });
    const [task] = (await edit([{ type: "add", title: "Review" }])).opened;
    const before = await teams.getSnapshot(team.id, 100);
    for (const operation of [
      { type: "update", taskId: task!.id, patch: { artifactId } },
      { type: "assign", taskId: task!.id, assigneeId: other.id },
    ] satisfies EditTeamTasksInput["operations"]) {
      await expect(
        edit([{ type: "update", taskId: task!.id, patch: { status: "completed" } }, operation]),
      ).rejects.toThrow();
      expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
    }
  });

  test("stale references do not block progress or moves, but cannot be introduced", async () => {
    const { database, teams, team, task, edit, artifactId } = await setup();
    // Simulate references left behind by an external relocation or repair.
    await database`
      INSERT INTO team_tasks ${database({
        team_id: team.id,
        id: "output",
        parent_id: task.id,
        position: 0,
        title: "Output",
        status: "pending",
        priority: "normal",
        assignee_id: "former-member",
        opened_by: team.id,
        artifact_id: artifactId,
        opened_at: task.openedAt,
        updated_at: task.openedAt,
      })}
    `;
    await database`DELETE FROM team_artifacts WHERE team_id = ${team.id}`;
    await edit([
      { type: "update", taskId: task.id, patch: { status: "in_progress" } },
      { type: "move", taskId: "output" },
    ]);
    const [, output] = await teams.listTasks(team.id);
    expect(output).toMatchObject({ assigneeId: "former-member", artifactId });
    expect(output).not.toHaveProperty("parentId");
    const before = await teams.getSnapshot(team.id, 100);
    for (const operation of [
      { type: "add", title: "Copy", assigneeId: "former-member" },
      { type: "assign", taskId: task.id, assigneeId: "former-member" },
      { type: "update", taskId: task.id, patch: { artifactId } },
    ] satisfies EditTeamTasksInput["operations"]) {
      await expect(
        edit([{ type: "update", taskId: task.id, patch: { status: "completed" } }, operation]),
      ).rejects.toThrow();
      expect(await teams.getSnapshot(team.id, 100)).toEqual(before);
    }
    await edit([
      { type: "assign", taskId: "output", assigneeId: null },
      { type: "update", taskId: "output", patch: { artifactId: null } },
    ]);
    const [, cleared] = await teams.listTasks(team.id);
    expect(cleared).not.toHaveProperty("assigneeId");
    expect(cleared).not.toHaveProperty("artifactId");
  });

  test("a departing member releases its tasks, each publishing its change", async () => {
    const { teams, team, edit } = await setup();
    const { member } = await teams.createMember(teamAgent(team.id, "builder-session", "Builder"));
    await edit([
      { type: "assign", taskId: "t1", assigneeId: member.id },
      { type: "add", title: "Verify", assigneeId: team.id },
    ]);
    const { events } = (await teams.deleteMember(member.id))!;
    const [released, verify] = await teams.listTasks(team.id);
    expect(released).not.toHaveProperty("assigneeId");
    expect(verify).toMatchObject({ assigneeId: team.id });
    expect(events[0]).toMatchObject({ type: "task", task: released });
    expect(events.slice(1).map((event) => event.type)).toEqual(["message"]);
  });

  test("an opened task starts its thread with a typed note, and notes reply in it", async () => {
    const { database, teams, team, task, edit } = await setup();
    const [opening] = await teams.listThread(team.id, task.threadSequence!);
    expect(opening).toMatchObject({
      sender: { type: "system" },
      content: {
        type: "task_opened",
        taskId: task.id,
        title: "Review",
        actor: { type: "agent", agentId: team.id },
      },
    });
    const first = await edit([
      { type: "update", taskId: task.id, patch: { status: "in_progress" }, note: "Starting." },
    ]);
    expect(first.events.filter((event) => event.type === "message")).toMatchObject([
      {
        message: {
          sender: { type: "agent", agentId: team.id },
          content: "Starting.",
          threadSequence: task.threadSequence,
        },
      },
    ]);
    // A migrated task has no thread until something posts into it.
    await database`
      UPDATE team_tasks SET thread_sequence = NULL WHERE team_id = ${team.id} AND id = ${task.id}
    `;
    const { events } = await edit([
      { type: "update", taskId: task.id, patch: { title: "Review the API" }, note: "Narrowed." },
    ]);
    const [root, note, changed] = events;
    expect(root).toMatchObject({
      message: { content: { type: "task_opened", taskId: task.id, title: "Review the API" } },
    });
    const thread = root!.type === "message" ? root.message.sequence : 0;
    expect(note).toMatchObject({ message: { content: "Narrowed.", threadSequence: thread } });
    expect(changed).toMatchObject({ type: "task", task: { threadSequence: thread } });
    expect((await teams.listThread(team.id, thread)).map(({ sequence }) => sequence)).toEqual([
      thread,
      thread + 1,
    ]);
  });

  test("an assignee edits its own tasks, and only the lead's close completes the list", async () => {
    const { teams, team, task, edit } = await setup();
    const { member } = await teams.createMember(teamAgent(team.id, "builder-session", "Builder"));
    await edit([{ type: "assign", taskId: task.id, assigneeId: member.id }]);
    const asMember = (operations: EditTeamTasksInput["operations"]) =>
      teams.editTasks(member.id, { operations });
    const { opened } = await asMember([
      { type: "add", parentId: task.id, title: "Draft", note: "Splitting out the draft." },
      { type: "update", taskId: task.id, patch: { status: "in_review" }, note: "Ready." },
    ]);
    expect(opened).toMatchObject([{ id: "t2", assigneeId: member.id }]);
    await expect(
      asMember([{ type: "update", taskId: "t2", patch: { status: "completed" } }]),
    ).rejects.toThrow("Only the lead closes");
    await expect(asMember([{ type: "remove", taskId: "t2" }])).rejects.toThrow(
      "Only the lead can remove",
    );
    const { events } = await edit([
      { type: "update", taskId: "t2", patch: { status: "cut" } },
      { type: "update", taskId: task.id, patch: { status: "completed" }, note: "Shipped." },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "message",
      message: { content: { type: "tasks_completed" } },
    });
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

  test("records metadata and preview messages", async () => {
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
      preview: { kind: "url", url: "http://127.0.0.1:3000" },
    });

    const actor = { type: "agent", agentId: team.id } as const;
    const messages = update.events.filter((event) => event.type === "message");
    expect(messages).toHaveLength(update.events.length);
    expect(messages.map(({ message }) => message.content)).toEqual([
      { type: "team_renamed", actor, name: "Delivery room" },
      { type: "team_purpose_changed", actor, purpose: "Ship and validate the product." },
      { type: "team_directory_changed", actor, directory: "/workspace/delivery" },
      { type: "preview_changed", actor, preview: { kind: "url", url: "http://127.0.0.1:3000" } },
    ]);
    expect(messages.map(({ message }) => message.sequence)).toEqual([2, 3, 4, 5]);
    expect(messages.map(({ revision }) => revision)).toEqual(
      [1, 2, 3, 4].map((offset) => revision! + offset),
    );
    expect((await teams.getRoster(team.id))?.revision).toBe(revision! + 4);
    expect(await teams.getTeam(team.id)).toEqual(update.team);
    const cleared = await teams.updateTeam(team.id, { preview: null });
    expect(cleared.events).toMatchObject([
      {
        type: "message",
        revision: revision! + 5,
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
    await expect(teams.updateTeam(member.id, { name: "Take over" })).rejects.toThrow(
      "Only the team lead",
    );
  });

  test("default avatar initialization does not overwrite a concurrent authored icon", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Identity", ...TEAM_DEFAULTS });
    const authored = { mark: "M5 12h14M12 5v14", color: "#7c3aed" };
    const fallback = { mark: "M4 20L12 4l8 16Z", color: "#0f766e" };
    const [, initialized] = await Promise.all([
      teams.updateTeam(team.id, { avatar: authored }),
      teams.initializeAvatar(team.id, fallback),
    ]);
    expect(initialized.team.avatar).toEqual(authored);
    expect(initialized.events).toEqual([]);
    expect((await teams.getTeam(team.id))?.avatar).toEqual(authored);
  });

  test("team icons persist quietly, can be replaced or cleared, and survive renames", async () => {
    const teams = await openTeams();
    const team = await createStoredTeam(teams, { name: "Design", ...TEAM_DEFAULTS });
    const { member } = await teams.createMember(teamAgent(team.id, "designer", "Designer"));
    const before = (await teams.getSnapshot(team.id, 100))!;
    const avatars = [
      { mark: "M5 12h14M12 5v14", color: "#7c3aed" },
      { mark: "M4 20L12 4l8 16Z", color: "#0f766e" },
    ];

    for (const [index, avatar] of avatars.entries()) {
      const change = await teams.updateTeam(team.id, { avatar });
      expect(change.events).toEqual([
        { type: "avatar", avatar, revision: before.revision + index + 1 },
      ]);
      expect(change.team).toEqual({ ...before.team, avatar });
      expect(await teams.getTeam(team.id)).toEqual(change.team);
      expect((await teams.listTeams()).teams[0]?.avatar).toEqual(avatar);
      expect((await teams.getSnapshot(team.id, 100))?.team.avatar).toEqual(avatar);
      expect((await teams.updateTeam(team.id, { avatar: { ...avatar } })).events).toEqual([]);
    }
    expect((await teams.getSnapshot(team.id, 100))?.messages).toEqual(before.messages);
    await expect(teams.updateTeam(member.id, { avatar: avatars[0] })).rejects.toThrow(
      "Only the team lead",
    );
    const renamed = await teams.updateTeam(team.id, { name: "Product design" });
    expect(renamed.team.avatar).toEqual(avatars[1]);
    const cleared = await teams.updateTeam(team.id, { avatar: null });
    expect(cleared.events).toEqual([
      { type: "avatar", avatar: null, revision: before.revision + 4 },
    ]);
    expect((await teams.getTeam(team.id))?.avatar).toBeUndefined();
    expect((await teams.updateTeam(team.id, { avatar: null })).events).toEqual([]);
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

  test("each team's handle is its own, and no team can take the lead's", async () => {
    const teams = await openTeams();
    const docs = await createStoredTeam(teams, { name: "Docs", ...TEAM_DEFAULTS });
    const ops = await createStoredTeam(teams, { name: "Ops", ...TEAM_DEFAULTS });

    await expect(createStoredTeam(teams, { name: "docs", ...TEAM_DEFAULTS })).rejects.toThrow(
      "Team Docs already uses the @docs mention.",
    );
    await expect(createStoredTeam(teams, { name: "Lead", ...TEAM_DEFAULTS })).rejects.toThrow(
      "Every team's lead already uses the @lead mention.",
    );
    await expect(teams.editTeam({ teamId: ops.id, name: "DOCS" })).rejects.toThrow(
      "Team Docs already uses the @docs mention.",
    );
    expect((await teams.editTeam({ teamId: docs.id, name: "Docs!" })).team.name).toBe("Docs!");
  });

  test("another team's message keeps who wrote it there, and linked threads resolve both ways", async () => {
    const teams = await openTeams();
    const docs = await createStoredTeam(teams, { name: "Docs", ...TEAM_DEFAULTS });
    const ops = await createStoredTeam(teams, { name: "Ops", ...TEAM_DEFAULTS });
    for (const by of ["lead", "user"] as const) {
      await teams.appendMessage({
        id: by,
        teamId: ops.id,
        sender: { type: "team", teamId: docs.id, by },
        content: "@ops check",
      });
    }
    expect((await teams.listMessagesAfter(ops.id)).map(({ sender }) => sender)).toEqual([
      { type: "team", teamId: docs.id, by: "lead" },
      { type: "team", teamId: docs.id, by: "user" },
    ]);

    await teams.linkPeerThreads(docs.id, 4, ops.id, 1);
    expect(await teams.getPeerThread(docs.id, 4, ops.id)).toBe(1);
    expect(await teams.getPeerThread(ops.id, 1, docs.id)).toBe(4);
    expect(await teams.getPeerThread(ops.id, 2, docs.id)).toBeNull();
  });

  test("a moved member reads its new team from now on, unless the team is paused or its name is taken", async () => {
    const teams = await openTeams();
    const docs = await createStoredTeam(teams, { name: "Docs", ...TEAM_DEFAULTS });
    const ops = await createStoredTeam(teams, { name: "Ops", ...TEAM_DEFAULTS });
    await teams.createMember(teamAgent(docs.id, "writer", "Writer"));
    await teams.setAgentStatus("writer", { state: "working", text: "Drafting" });
    await teams.appendMessage({
      id: "earlier",
      teamId: ops.id,
      sender: { type: "user" },
      content: "Earlier context",
    });

    await expect(teams.moveMembers(docs.id, [docs.id], ops.id)).rejects.toThrow("never its lead");
    await teams.editTeam({ teamId: ops.id, paused: true });
    await expect(teams.moveMembers(docs.id, ["writer"], ops.id)).rejects.toThrow("Resume the team");
    await teams.editTeam({ teamId: ops.id, paused: false });
    await teams.createMember(teamAgent(ops.id, "other-writer", "Writer"));
    await expect(teams.moveMembers(docs.id, ["writer"], ops.id)).rejects.toThrow(
      "already uses the @writer mention",
    );
    await teams.deleteMember("other-writer");

    const { latestSequence } = (await teams.getTeam(ops.id))!;
    const change = await teams.moveMembers(docs.id, ["writer"], ops.id);
    expect(change.target.team.latestSequence).toBe(latestSequence + 1);
    expect(await teams.getAgent("writer")).toMatchObject({
      teamId: ops.id,
      seenThrough: latestSequence,
    });
    expect((await teams.getAgent("writer"))?.status).toBeUndefined();
    expect((await teams.listMessagesAfter(docs.id)).at(-1)?.content).toMatchObject({
      type: "member_left",
      member: { id: "writer", teamId: docs.id },
    });
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

  test("routines target only current agents in their team and can return to the lead", async () => {
    const { teams, team } = await setup();
    const { member } = await teams.createMember(teamAgent(team.id, "watcher", "Watcher"));
    const other = await createStoredTeam(teams, { name: "Other", ...TEAM_DEFAULTS });
    const input = { title: "CI", schedule: "0 * * * *", prompt: "Check CI" };
    const { routine } = await teams.setRoutine(team.id, { ...input, agentId: member.id });

    expect((await teams.getSnapshot(team.id, 100))?.routines).toEqual([routine]);
    expect(routine.agentId).toBe(member.id);
    expect(
      (await teams.setRoutine(team.id, { ...input, routineId: routine.id, agentId: member.id }))
        .events,
    ).toEqual([]);
    await expect(teams.setRoutine(team.id, { ...input, agentId: other.id })).rejects.toThrow(
      "Routine agent must belong to this team.",
    );
    await expect(teams.setRoutine(team.id, { ...input, agentId: "missing" })).rejects.toThrow(
      "Team agent not found.",
    );

    const changed = await teams.setRoutine(team.id, {
      ...input,
      routineId: routine.id,
      agentId: team.id,
    });
    expect(changed.routine.agentId).toBeUndefined();
    expect(await teams.listRoutines(team.id)).toEqual([changed.routine]);
  });

  test("removing a member deletes only its routines and publishes their deletion", async () => {
    const { teams, team } = await setup();
    const { member } = await teams.createMember(teamAgent(team.id, "watcher", "Watcher"));
    const input = { title: "CI", schedule: "0 * * * *", prompt: "Check CI" };
    const targeted = await teams.setRoutine(team.id, { ...input, agentId: member.id });
    const defaulted = await teams.setRoutine(team.id, input);
    const change = await teams.deleteMember(member.id);

    expect(
      change?.events.map((event) => event.type === "message" && event.message.content),
    ).toEqual([
      { type: "routine_deleted", routine: targeted.routine },
      { type: "member_left", member },
    ]);
    expect((await teams.getSnapshot(team.id, 100))?.routines).toEqual([defaulted.routine]);
    expect(await teams.deleteMember(member.id)).toBeNull();
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
    const due = [{ teamId: team.id, agentId: team.id, title: "CI", prompt: "Check CI" }];

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
    expect(due.routines).toEqual([
      { teamId: other.id, agentId: other.id, title: "CI", prompt: "Check CI" },
    ]);
    expect((await teams.getAgent(team.id))?.status).toEqual(status);

    await teams.editTeam({ teamId: team.id, paused: false });
    const resumed = await teams.claimDueWakes(localTime(14, 10));
    expect(resumed.followUps.map(({ agentId }) => agentId)).toEqual([team.id]);
    expect(resumed.routines).toEqual([
      { teamId: team.id, agentId: team.id, title: "CI", prompt: "Check CI" },
    ]);
    expect(await teams.claimDueWakes(localTime(14, 10))).toEqual({
      followUps: [],
      routines: [],
    });
  });
});
