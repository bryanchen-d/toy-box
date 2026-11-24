import { describe, expect, test } from "bun:test";
import {
  applyTeamTaskEdits,
  assertTeamTurnReports,
  editTeamTasksInputSchema,
  mentionsTeamTask,
  nextTeamTask,
  orderTeamTasks,
  teamTaskReportSchema,
  teamTaskState,
  teamTasksByPriority,
  teamTasksComplete,
  teamTaskNotifications,
  teamTasksDiff,
  teamTasksForAgent,
  teamTaskTree,
  teamTurnReportsDue,
  TEAM_TASK_STATUSES,
  type EditTeamTasksInput,
  type TeamTask,
  type TeamTaskEditor,
  type TeamTaskStatus,
} from "./tasks";
import { teamTask as task } from "./testFixtures";

const lead = { type: "agent", agentId: "team" } as const;
const OPENED = "2026-11-24T10:00:00.000Z";
const NOW = "2026-11-24T11:00:00.000Z";

function edit(
  tasks: readonly TeamTask[],
  operations: EditTeamTasksInput["operations"],
  lastTaskNumber = 0,
  editor: TeamTaskEditor = { agentId: "team", isLead: true },
) {
  return applyTeamTaskEdits(tasks, editTeamTasksInputSchema.parse({ operations }).operations, {
    editor,
    now: NOW,
    lastTaskNumber,
  });
}

const byId = (tasks: readonly TeamTask[], id: string) => tasks.find((task) => task.id === id);

test("every status belongs to exactly one group, which decides whether a task is open", () => {
  const { open, closed } = TEAM_TASK_STATUSES;
  expect(open).toEqual(["pending", "in_progress", "blocked", "in_review"]);
  expect(closed).toEqual(["completed", "cancelled", "deferred", "cut", "duplicate"]);
  for (const status of open) expect(teamTaskState(status)).toBe("open");
  for (const status of closed) expect(teamTaskState(status)).toBe("closed");
});

test("opening numbers tasks from the counter and stamps who opened them and when", () => {
  const result = edit(
    [task("t3")],
    [
      { type: "add", title: "Design", description: "## Why\nUsers asked.", priority: "high" },
      {
        type: "add",
        parentId: "t3",
        title: "Build",
        assigneeId: "builder",
        children: [{ title: "API" }, { title: "UI" }],
      },
    ],
    3,
  );
  expect(result.lastTaskNumber).toBe(7);
  expect(result.opened.map(({ id, parentId }) => [id, parentId])).toEqual([
    ["t4", undefined],
    ["t5", "t3"],
    ["t6", "t5"],
    ["t7", "t5"],
  ]);
  expect(byId(result.tasks, "t4")).toEqual({
    id: "t4",
    position: 1,
    title: "Design",
    description: "## Why\nUsers asked.",
    status: "pending",
    priority: "high",
    openedBy: lead,
    openedAt: NOW,
    updatedAt: NOW,
    updatedBy: lead,
  });
  expect(byId(result.tasks, "t5")).toMatchObject({ assigneeId: "builder", priority: "normal" });
  expect([byId(result.tasks, "t6")?.position, byId(result.tasks, "t7")?.position]).toEqual([0, 1]);
});

test("removing a task never frees its number", () => {
  const first = edit([], [{ type: "add", title: "Mistake" }]);
  const removed = edit(first.tasks, [{ type: "remove", taskId: "t1" }], first.lastTaskNumber);
  const next = edit(removed.tasks, [{ type: "add", title: "Real work" }], removed.lastTaskNumber);
  expect(next.opened.map(({ id }) => id)).toEqual(["t2"]);
});

test("updates preserve omitted fields, clear nulls, and stamp only real changes", () => {
  const before = task("t1", {
    description: "Old",
    artifactId: "machine:/review.md",
    diff: { added: 12, removed: 3 },
  });
  const { tasks } = edit(
    [before],
    [{ type: "update", taskId: "t1", patch: { title: "Revised", description: null, diff: null } }],
  );
  expect(tasks).toEqual([
    { ...task("t1", { artifactId: "machine:/review.md" }), title: "Revised", updatedAt: NOW },
  ]);
  const unchanged = edit([before], [{ type: "update", taskId: "t1", patch: { title: "t1" } }]);
  expect(unchanged.tasks[0]).toBe(before);
});

test("only the end of a batch counts, so a change and its undo leave the task untouched", () => {
  const before = task("t1");
  const { tasks } = edit(
    [before],
    [
      { type: "update", taskId: "t1", patch: { status: "completed" } },
      { type: "assign", taskId: "t1", assigneeId: "builder" },
      { type: "update", taskId: "t1", patch: { status: "pending" } },
      { type: "assign", taskId: "t1", assigneeId: null },
    ],
  );
  expect(tasks[0]).toBe(before);
});

test.each<[TeamTaskStatus, TeamTaskStatus, string | undefined]>([
  ["in_review", "completed", NOW],
  ["pending", "cut", NOW],
  ["completed", "deferred", OPENED],
  ["completed", "in_progress", undefined],
])("moving from %s to %s records when the task closed", (from, to, closedAt) => {
  const before = task("t1", {
    status: from,
    ...(from === "completed" ? { closedAt: OPENED } : {}),
  });
  const [after] = edit([before], [{ type: "update", taskId: "t1", patch: { status: to } }]).tasks;
  expect(after?.closedAt).toBe(closedAt);
  expect(after?.status).toBe(to);
});

test("assigning sets or clears the one assignee", () => {
  const assigned = edit([task("t1")], [{ type: "assign", taskId: "t1", assigneeId: "builder" }]);
  expect(assigned.tasks[0]).toMatchObject({ assigneeId: "builder", updatedAt: NOW });
  const released = edit(assigned.tasks, [{ type: "assign", taskId: "t1", assigneeId: null }]);
  expect(released.tasks[0]).not.toHaveProperty("assigneeId");
});

test("moving keeps a subtree intact at the end of its new parent and never inside itself", () => {
  const tasks = [
    task("t1"),
    task("t2", { position: 1 }),
    task("t3", { parentId: "t1" }),
    task("t4", { parentId: "t3", diff: { added: 1, removed: 0 } }),
    task("t5", { parentId: "t2" }),
  ];
  const moved = edit(tasks, [{ type: "move", taskId: "t3", parentId: "t2" }]).tasks;
  expect(byId(moved, "t3")).toMatchObject({ parentId: "t2", position: 1, updatedAt: NOW });
  expect(byId(moved, "t4")).toEqual(tasks[3]);
  const toRoot = edit(tasks, [{ type: "move", taskId: "t3" }]).tasks;
  expect(byId(toRoot, "t3")).toMatchObject({ position: 2 });
  expect(byId(toRoot, "t3")).not.toHaveProperty("parentId");
  for (const parentId of ["t3", "t4"]) {
    expect(() => edit(tasks, [{ type: "move", taskId: "t3", parentId }])).toThrow(
      "outside its own subtree",
    );
  }
});

test("removing a task removes its subtasks", () => {
  const tasks = [task("t1"), task("t2", { parentId: "t1" }), task("t3", { parentId: "t2" })];
  expect(edit(tasks, [{ type: "remove", taskId: "t2" }]).tasks).toEqual([tasks[0]]);
});

test("edits reject unknown targets and a 51st sibling, leaving the input untouched", () => {
  const tasks = [
    task("t1"),
    ...Array.from({ length: 50 }, (_, index) =>
      task(`t${index + 2}`, { parentId: "t1", position: index }),
    ),
    task("t52", { position: 1 }),
  ];
  const before = structuredClone(tasks);
  for (const operation of [
    { type: "update", taskId: "missing", patch: { status: "completed" } },
    { type: "assign", taskId: "missing", assigneeId: null },
    { type: "add", parentId: "missing", title: "Orphan" },
    { type: "add", parentId: "t1", title: "One too many" },
    { type: "move", taskId: "t52", parentId: "t1" },
  ] satisfies EditTeamTasksInput["operations"]) {
    expect(() => edit(tasks, [operation], 52)).toThrow();
  }
  expect(tasks).toEqual(before);
});

test.each([{ id: "t3" }, { assigneeId: "builder" }, { parentId: "t2" }])(
  "patches cannot change identity, assignment, or placement: %j",
  (patch) => {
    expect(
      editTeamTasksInputSchema.safeParse({
        operations: [{ type: "update", taskId: "t1", patch: { title: "Revised", ...patch } }],
      }).success,
    ).toBe(false);
  },
);

describe("an assignee's authority", () => {
  const builder = { agentId: "builder", isLead: false };
  const tasks = [
    task("t1", { assigneeId: "builder", status: "in_progress" }),
    task("t2", { position: 1, assigneeId: "critic" }),
    task("t3", { position: 2, assigneeId: "builder", status: "completed" }),
  ];
  const asBuilder = (operations: EditTeamTasksInput["operations"]) =>
    edit(tasks, operations, 3, builder);

  test("adds subtasks under its own open tasks, assigned to itself and opened by it", () => {
    const { opened } = asBuilder([
      { type: "add", parentId: "t1", title: "Parser", children: [{ title: "Lexer" }] },
    ]);
    expect(opened.map(({ id, assigneeId, openedBy }) => [id, assigneeId, openedBy])).toEqual([
      ["t4", "builder", { type: "agent", agentId: "builder" }],
      ["t5", "builder", { type: "agent", agentId: "builder" }],
    ]);
  });

  test("updates its own open tasks up to handing them off for review", () => {
    const { tasks: updated } = asBuilder([
      {
        type: "update",
        taskId: "t1",
        patch: { status: "in_review", diff: { added: 4, removed: 1 } },
      },
    ]);
    expect(byId(updated, "t1")).toMatchObject({
      status: "in_review",
      diff: { added: 4, removed: 1 },
      updatedBy: { type: "agent", agentId: "builder" },
    });
  });

  test.each<[string, EditTeamTasksInput["operations"][number], string]>([
    ["open top-level work", { type: "add", title: "Side quest" }, "own open tasks"],
    ["add under another's task", { type: "add", parentId: "t2", title: "Help" }, "own open tasks"],
    ["add under a closed task", { type: "add", parentId: "t3", title: "More" }, "own open tasks"],
    [
      "assign its subtasks to another",
      {
        type: "add",
        parentId: "t1",
        title: "Review",
        children: [{ title: "Check", assigneeId: "critic" }],
      },
      "assigned to you",
    ],
    [
      "update another's task",
      { type: "update", taskId: "t2", patch: { title: "Mine" } },
      "own open",
    ],
    [
      "reopen a closed task",
      { type: "update", taskId: "t3", patch: { status: "in_progress" } },
      "own open",
    ],
    [
      "close its task",
      { type: "update", taskId: "t1", patch: { status: "completed" } },
      "Only the lead closes",
    ],
    [
      "cancel its task",
      { type: "update", taskId: "t1", patch: { status: "cancelled" } },
      "Only the lead closes",
    ],
    [
      "reassign",
      { type: "assign", taskId: "t1", assigneeId: "critic" },
      "Only the lead can assign",
    ],
    ["move", { type: "move", taskId: "t1" }, "Only the lead can move"],
    ["remove", { type: "remove", taskId: "t1" }, "Only the lead can remove"],
  ])("cannot %s", (_case, operation, error) => {
    expect(() => asBuilder([operation])).toThrow(error);
  });

  test("may edit a subtask it opened earlier in the same batch", () => {
    const { tasks: updated } = asBuilder([
      { type: "add", parentId: "t1", title: "Parser" },
      { type: "update", taskId: "t4", patch: { status: "in_progress" } },
    ]);
    expect(byId(updated, "t4")?.status).toBe("in_progress");
  });
});

test("notes name the task whose thread they post into, including one the batch opens", () => {
  const { notes } = edit(
    [task("t1")],
    [
      { type: "add", title: "Parser", note: "Split out of t1." },
      { type: "update", taskId: "t1", patch: { status: "in_progress" }, note: "Starting." },
      { type: "assign", taskId: "t1", assigneeId: "builder", note: "Yours." },
    ],
    1,
  );
  expect(notes).toEqual([
    { taskId: "t2", note: "Split out of t1." },
    { taskId: "t1", note: "Starting." },
    { taskId: "t1", note: "Yours." },
  ]);
  expect(() =>
    edit(
      [task("t1")],
      [
        { type: "update", taskId: "t1", patch: { title: "Gone" }, note: "Renamed." },
        { type: "remove", taskId: "t1" },
      ],
    ),
  ).toThrow("can't take a note");
});

describe("who a task edit wakes", () => {
  const assigned = task("t1", { assigneeId: "builder", status: "in_progress" });
  const notified = (after: TeamTask[], editorId = "team", before: TeamTask[] = [assigned]) =>
    teamTaskNotifications(before, after, editorId).map(
      ({ agentId, taskId, change }) => `${agentId} ${taskId}: ${change}`,
    );

  test("assigning wakes the new assignee, and reassigning tells the previous one", () => {
    expect(notified([assigned, task("t2", { position: 1, assigneeId: "critic" })])).toEqual([
      "critic t2: assigned to you",
    ]);
    expect(notified([{ ...assigned, assigneeId: "critic" }])).toEqual([
      "critic t1: assigned to you",
      "builder t1: no longer assigned to you",
    ]);
    expect(notified([task("t1", { status: "in_progress" })])).toEqual([
      "builder t1: no longer assigned to you",
    ]);
  });

  test("anyone else's change to the work wakes the assignee", () => {
    expect(notified([{ ...assigned, title: "Narrower" }])).toEqual(["builder t1: edited"]);
    expect(notified([{ ...assigned, diff: { added: 1, removed: 0 } }])).toEqual([
      "builder t1: edited",
    ]);
    expect(notified([{ ...assigned, status: "blocked" }])).toEqual([
      "builder t1: moved to blocked",
    ]);
    expect(notified([{ ...assigned, status: "cancelled" }])).toEqual([
      "builder t1: closed as cancelled",
    ]);
    expect(notified([])).toEqual(["builder t1: removed"]);
  });

  test("sending a review back wakes the assignee, but closing it wakes no one", () => {
    const review = { ...assigned, status: "in_review" as const };
    expect(notified([{ ...review, status: "in_progress" }], "team", [review])).toEqual([
      "builder t1: moved to in_progress",
    ]);
    expect(notified([{ ...review, status: "completed" }], "team", [review])).toEqual([]);
  });

  test("the assignee's own changes and moving a task wake no one", () => {
    expect(notified([{ ...assigned, status: "in_review" }], "builder")).toEqual([]);
    expect(notified([{ ...assigned, parentId: "t9", position: 3 }])).toEqual([]);
    expect(notified([assigned, task("t2", { assigneeId: "team" })])).toEqual([]);
  });
});

test("an agent's queue lists high priority first, then tree order", () => {
  const tasks = [
    task("t1", { priority: "low" }),
    task("t2", { position: 1 }),
    task("t3", { parentId: "t2", priority: "high" }),
    task("t4", { position: 2, priority: "high" }),
  ];
  expect(teamTasksByPriority(tasks).map(({ id }) => id)).toEqual(["t3", "t4", "t2", "t1"]);
});

describe("turn reports", () => {
  const tasks = [
    task("t1", { assigneeId: "builder", status: "in_progress" }),
    task("t2", { position: 1, assigneeId: "builder", status: "completed" }),
    task("t3", { position: 2, assigneeId: "critic" }),
    task("t4", { position: 3, assigneeId: "builder", priority: "low" }),
    task("t5", { position: 4, assigneeId: "builder", priority: "high", status: "blocked" }),
  ];

  test("a turn reports on the tasks that woke it while they're still the agent's and open", () => {
    const due = teamTurnReportsDue(tasks, "builder", ["t1", "t2", "t3", "t4"]);
    expect(due.map(({ id }) => id)).toEqual(["t1", "t4"]);
    expect(teamTurnReportsDue(tasks, "builder")).toEqual([]);
  });

  test("a finish names each task it owes a report and reports each once", () => {
    const due = teamTurnReportsDue(tasks, "builder", ["t1", "t4"]);
    expect(() => assertTeamTurnReports(due, [{ taskId: "t1" }])).toThrow(
      "This turn was woken for t4.",
    );
    expect(() =>
      assertTeamTurnReports(due, [{ taskId: "t1" }, { taskId: "t4" }, { taskId: "t1" }]),
    ).toThrow("Report on t1 once.");
    expect(() =>
      assertTeamTurnReports(due, [{ taskId: "t4" }, { taskId: "t1" }, { taskId: "t5" }]),
    ).not.toThrow();
  });

  test("only an in_progress report continues later, within two hours", () => {
    const report = { taskId: "t1", status: "in_progress", note: "CI is running." };
    expect(teamTaskReportSchema.safeParse({ ...report, continueAfterMinutes: 30 }).success).toBe(
      true,
    );
    expect(
      teamTaskReportSchema.safeParse({ ...report, status: "blocked", continueAfterMinutes: 30 })
        .success,
    ).toBe(false);
    expect(teamTaskReportSchema.safeParse({ ...report, continueAfterMinutes: 121 }).success).toBe(
      false,
    );
  });

  test("the next task is the agent's highest-priority pending one", () => {
    expect(nextTeamTask(tasks, "builder")?.id).toBe("t4");
    expect(
      nextTeamTask(
        [...tasks, task("t6", { position: 5, assigneeId: "builder", priority: "high" })],
        "builder",
      )?.id,
    ).toBe("t6");
    expect(nextTeamTask(tasks, "critic")?.id).toBe("t3");
    expect(nextTeamTask(tasks, "lead")).toBeUndefined();
  });
});

test("the tree orders siblings by position and lists parents before their subtasks", () => {
  const tasks = [
    task("t3", { parentId: "t1", position: 1 }),
    task("t2", { position: 1 }),
    task("t4", { parentId: "t1", position: 0, assigneeId: "builder" }),
    task("t1", { position: 0, assigneeId: "builder" }),
  ];
  expect(orderTeamTasks(tasks).map(({ id }) => id)).toEqual(["t1", "t4", "t3", "t2"]);
  expect(teamTaskTree(tasks).map(({ id, children }) => [id, children.map(({ id }) => id)])).toEqual(
    [
      ["t1", ["t4", "t3"]],
      ["t2", []],
    ],
  );
  expect(teamTasksForAgent(tasks, "builder").map(({ id }) => id)).toEqual(["t1", "t4"]);
});

test("totals count direct work and descendants once, and keep unreported work absent", () => {
  const tasks = [
    task("t1", { diff: { added: 5, removed: 1 } }),
    task("t2", { parentId: "t1", diff: { added: 10, removed: 4 } }),
    task("t3", { parentId: "t2", diff: { added: 7, removed: 2 } }),
    task("t4", { position: 1 }),
  ];
  expect(teamTasksDiff(tasks)).toEqual({ added: 22, removed: 7 });
  const [parent, other] = teamTaskTree(tasks);
  expect(teamTasksDiff([parent!])).toEqual({ added: 22, removed: 7 });
  expect(teamTasksDiff([other!])).toBeUndefined();
  expect(teamTasksDiff([task("t5", { diff: { added: 0, removed: 0 } })])).toEqual({
    added: 0,
    removed: 0,
  });
});

test("a list is complete only when every task is closed and at least one completed", () => {
  const closed = (status: TeamTaskStatus) => task("t1", { status });
  expect(teamTasksComplete([])).toBe(false);
  expect(teamTasksComplete([closed("cancelled"), closed("cut")])).toBe(false);
  expect(teamTasksComplete([closed("completed"), closed("in_review")])).toBe(false);
  expect(teamTasksComplete([closed("completed"), closed("deferred"), closed("duplicate")])).toBe(
    true,
  );
});

test("a message cites a task only by its whole, exactly cased ID", () => {
  for (const text of ["t1", "Finished t1.", "**t1**: done", "(t1, t2)", "`t1`", "t1's review"]) {
    expect(mentionsTeamTask(text, "t1")).toBe(true);
  }
  for (const text of ["t12", "t1a", "at1", "t1-b", "T1", "t2"]) {
    expect(mentionsTeamTask(text, "t1")).toBe(false);
  }
  expect(mentionsTeamTask("Moved t12 after t1", "t1")).toBe(true);
  expect(mentionsTeamTask("Fix fix-auth first", "fix-auth")).toBe(true);
});
