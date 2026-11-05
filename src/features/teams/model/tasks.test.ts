import { expect, test } from "bun:test";
import {
  applyTeamTaskEdits,
  teamTasksDiff,
  teamTasksComplete,
  teamTasksForAgent,
  editTeamTasksInputSchema,
  type TeamTask,
  type EditTeamTasksInput,
} from "./tasks";

const task = (id: string): TeamTask => ({ id, title: id, status: "pending" });

test("agent tasks include directly assigned descendants without inheriting their parent's owner", () => {
  const tasks: TeamTask[] = [
    {
      ...task("t1"),
      ownerId: "lead",
      children: [
        {
          ...task("t2"),
          ownerId: "builder",
          status: "in_progress",
          children: [
            { ...task("t3"), status: "blocked" },
            { ...task("t4"), ownerId: "builder", status: "blocked" },
          ],
        },
        { ...task("t5"), ownerId: "builder", status: "done" },
      ],
    },
    { ...task("t6"), ownerId: "builder" },
  ];
  expect(teamTasksForAgent(tasks, "builder").map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "t2", status: "in_progress" },
    { id: "t4", status: "blocked" },
    { id: "t5", status: "done" },
    { id: "t6", status: "pending" },
  ]);
  expect(teamTasksForAgent(tasks, "lead").map(({ id }) => id)).toEqual(["t1"]);
  expect(teamTasksForAgent(tasks, "removed")).toEqual([]);
});

test("ordered edits target IDs, preserve omitted outcomes and descendants, and clear explicit nulls", () => {
  const tasks = [
    {
      ...task("t1"),
      children: [
        {
          ...task("t2"),
          ownerId: "critic",
          artifactId: "session:critic:review.md",
          diff: { added: 12, removed: 3 },
          children: [task("t3")],
        },
        { ...task("t4"), children: [task("t6")] },
      ],
    },
  ];
  const before = structuredClone(tasks);
  const { operations } = editTeamTasksInputSchema.parse({
    operations: [
      {
        type: "update",
        taskId: "t2",
        patch: { title: "Revised review", ownerId: null, diff: null },
      },
      { type: "add", parentId: "t2", task: task("t5") },
      { type: "remove", taskId: "t4" },
    ],
  });
  expect(applyTeamTaskEdits(tasks, operations)).toEqual([
    {
      ...task("t1"),
      children: [
        {
          id: "t2",
          title: "Revised review",
          status: "pending",
          artifactId: "session:critic:review.md",
          children: [task("t3"), task("t5")],
        },
      ],
    },
  ]);
  expect(tasks).toEqual(before);
});

test("edits reject unknown targets, duplicate IDs across branches, and a 51st subtask", () => {
  const tasks = applyTeamTaskEdits(
    [{ ...task("t1"), children: Array.from({ length: 49 }, (_, index) => task(`t${index + 2}`)) }],
    [
      { type: "add", parentId: "t1", task: task("t51") },
      { type: "add", task: task("t52") },
    ],
  );
  expect(tasks[0]!.children).toHaveLength(50);
  for (const operation of [
    { type: "update", taskId: "missing", patch: { status: "done" } },
    { type: "add", task: task("t2") },
    { type: "add", parentId: "t1", task: task("t53") },
    { type: "move", taskId: "t52", parentId: "t1" },
  ] satisfies EditTeamTasksInput["operations"]) {
    expect(() => applyTeamTaskEdits(tasks, [operation])).toThrow();
  }
});

test("a full group can move existing outcomes into a milestone without restating them", () => {
  const outcome = {
    ...task("t2"),
    artifactId: "machine:/review.md",
    diff: { added: 12, removed: 3 },
    children: [{ ...task("t100"), diff: { added: 0, removed: 0 } }],
  };
  const siblings = Array.from({ length: 49 }, (_, index) => task(`t${index + 3}`));
  const root = { ...task("t1"), children: [outcome, ...siblings] };
  const before = structuredClone(root);
  const { operations } = editTeamTasksInputSchema.parse({
    operations: [
      { type: "move", taskId: outcome.id },
      { type: "add", parentId: root.id, task: task("t52") },
      { type: "move", taskId: outcome.id, parentId: "t52" },
    ],
  });
  expect(applyTeamTaskEdits([root], operations)).toEqual([
    { ...before, children: [...siblings, { ...task("t52"), children: [before.children[0]] }] },
  ]);
  for (const parentId of [root.id, "t100"]) {
    expect(() => applyTeamTaskEdits([root], [{ type: "move", taskId: root.id, parentId }])).toThrow(
      "not found",
    );
  }
  expect(root).toEqual(before);
});

test.each([{ id: "t3" }, { children: [] }])(
  "patches cannot replace identity or descendants: %j",
  (patch) => {
    expect(
      editTeamTasksInputSchema.safeParse({
        operations: [{ type: "update", taskId: "t1", patch: { title: "Revised", ...patch } }],
      }).success,
    ).toBe(false);
  },
);

test("parent and whole-list totals count direct work and descendants exactly once", () => {
  const parent: TeamTask = {
    ...task("t1"),
    diff: { added: 5, removed: 1 },
    children: [
      {
        ...task("t2"),
        diff: { added: 10, removed: 4 },
        children: [{ ...task("t3"), diff: { added: 7, removed: 2 } }],
      },
      task("t4"),
    ],
  };
  const before = structuredClone(parent);
  expect(teamTasksDiff([parent])).toEqual({ added: 22, removed: 7 });
  expect(teamTasksDiff([parent, { ...task("t5"), diff: { added: 3, removed: 2 } }])).toEqual({
    added: 25,
    removed: 9,
  });
  expect(parent).toEqual(before);
});

test("unreported diffs stay absent while an explicitly reported zero survives roll-up", () => {
  expect(teamTasksDiff([{ ...task("t1"), children: [task("t2")] }])).toBeUndefined();
  expect(
    teamTasksDiff([
      {
        ...task("t1"),
        children: [{ ...task("t2"), diff: { added: 0, removed: 0 } }],
      },
    ]),
  ).toEqual({ added: 0, removed: 0 });
});

test("a task list is complete only when it has tasks and every subtask is done", () => {
  const release = (status: TeamTask["status"]): TeamTask => ({
    ...task("t1"),
    status: "done",
    children: [{ ...task("t2"), status }],
  });
  expect(teamTasksComplete([])).toBe(false);
  expect(teamTasksComplete([{ ...task("t1"), status: "in_progress" }])).toBe(false);
  expect(teamTasksComplete([release("blocked")])).toBe(false);
  expect(teamTasksComplete([release("done"), { ...task("t3"), status: "done" }])).toBe(true);
});
