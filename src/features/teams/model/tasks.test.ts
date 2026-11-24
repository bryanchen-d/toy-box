import { expect, test } from "bun:test";
import {
  applyTeamTaskEdits,
  editTeamTasksInputSchema,
  mentionsTeamTask,
  orderTeamTasks,
  teamTaskState,
  teamTasksComplete,
  teamTasksDiff,
  teamTasksForAgent,
  teamTaskTree,
  TEAM_TASK_STATUSES,
  type EditTeamTasksInput,
  type TeamTask,
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
) {
  return applyTeamTaskEdits(tasks, editTeamTasksInputSchema.parse({ operations }).operations, {
    actor: lead,
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
