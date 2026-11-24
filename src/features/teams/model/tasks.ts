import { z } from "zod";
import { diffStatsSchema, type DiffStats } from "@/shared/diffStats";
import type { TeamMessageActor } from ".";
import { applyPatch, hasChanges } from "./changes";

/**
 * Every task is open or closed, and its status says how. This grouping is the one place that
 * decides which, so filters, counts, and wakes never disagree with a task's status.
 */
export const TEAM_TASK_STATUSES = {
  open: ["pending", "in_progress", "blocked", "in_review"],
  closed: ["completed", "cancelled", "deferred", "cut", "duplicate"],
} as const;

export type TeamTaskState = keyof typeof TEAM_TASK_STATUSES;
export const teamTaskStatusSchema = z.enum([
  ...TEAM_TASK_STATUSES.open,
  ...TEAM_TASK_STATUSES.closed,
]);
export type TeamTaskStatus = z.output<typeof teamTaskStatusSchema>;
export const teamTaskPrioritySchema = z.enum(["high", "normal", "low"]);
export type TeamTaskPriority = z.output<typeof teamTaskPrioritySchema>;

export function teamTaskState(status: TeamTaskStatus): TeamTaskState {
  return (TEAM_TASK_STATUSES.closed as readonly TeamTaskStatus[]).includes(status)
    ? "closed"
    : "open";
}

export function isTeamTaskOpen({ status }: Pick<TeamTask, "status">): boolean {
  return teamTaskState(status) === "open";
}

/** One unit of the team's work. The server numbers, stamps, and orders it; agents set judgment. */
export type TeamTask = {
  /** `t<N>` from the team's counter, which never reuses a number; older IDs keep their text. */
  id: string;
  /** The task this one decomposes. */
  parentId?: string;
  /** Order among its siblings, ascending. */
  position: number;
  title: string;
  /** Markdown: an overview, why, the approach, and alternatives. Deeper design links a brief. */
  description?: string;
  status: TeamTaskStatus;
  priority: TeamTaskPriority;
  /** The one agent directly responsible for it. */
  assigneeId?: string;
  openedBy: TeamMessageActor;
  /** The `id` of the shared artifact this task produced. */
  artifactId?: string;
  /** Measured lines directly attributed to this task; totals derive from descendants. */
  diff?: DiffStats;
  /** The root of the task's thread, once it has one. */
  threadSequence?: number;
  openedAt: string;
  updatedAt: string;
  /** Who made its latest change: the lead, its assignee, or a member whose leaving released it. */
  updatedBy: TeamMessageActor;
  closedAt?: string;
};

/** A task with its subtasks, in sibling order, as lists present it. */
export type TeamTaskNode = TeamTask & { children: TeamTaskNode[] };

/** Arrange a team's tasks into their tree, each sibling list in order. */
export function teamTaskTree(tasks: readonly TeamTask[]): TeamTaskNode[] {
  const children = new Map<string | undefined, TeamTask[]>();
  for (const task of tasks) {
    const siblings = children.get(task.parentId) ?? [];
    siblings.push(task);
    children.set(task.parentId, siblings);
  }
  const build = (parentId: string | undefined): TeamTaskNode[] =>
    (children.get(parentId) ?? [])
      .sort((left, right) => left.position - right.position)
      .map((task) => ({ ...task, children: build(task.id) }));
  return build(undefined);
}

/** Every task in tree order: each parent before its subtasks, siblings in order. */
export function orderTeamTasks(tasks: readonly TeamTask[]): TeamTask[] {
  const flatten = (nodes: readonly TeamTaskNode[]): TeamTask[] =>
    nodes.flatMap(({ children, ...task }) => [task, ...flatten(children)]);
  return flatten(teamTaskTree(tasks));
}

/** The task whose thread starts at this sequence, with its subtasks, if a task's does. */
export function teamTaskByThread(
  tasks: readonly TeamTask[],
  threadSequence: number,
): TeamTaskNode | undefined {
  const find = (nodes: readonly TeamTaskNode[]): TeamTaskNode | undefined => {
    for (const node of nodes) {
      const found = node.threadSequence === threadSequence ? node : find(node.children);
      if (found) return found;
    }
  };
  return find(teamTaskTree(tasks));
}

/** The tasks assigned to an agent, in tree order. */
export function teamTasksForAgent(tasks: readonly TeamTask[], agentId: string): TeamTask[] {
  return orderTeamTasks(tasks).filter(({ assigneeId }) => assigneeId === agentId);
}

const PRIORITY_ORDER: Record<TeamTaskPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * A team's tasks in queue order: high priority first, then tree order within each priority.
 * Pass the whole list, since the tree places subtasks through their parents, then filter it.
 */
export function teamTasksByPriority(tasks: readonly TeamTask[]): TeamTask[] {
  return orderTeamTasks(tasks).sort(
    (left, right) => PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority],
  );
}

/**
 * Sum reported work without storing derived totals: every task in a flat list, or a node with its
 * subtasks when given tree nodes.
 */
export function teamTasksDiff(
  tasks: readonly { diff?: DiffStats; children?: readonly TeamTaskNode[] }[],
): DiffStats | undefined {
  return tasks
    .flatMap(({ diff, children = [] }) => [diff, teamTasksDiff(children)])
    .reduce<DiffStats | undefined>((total, diff) => {
      if (!diff) return total;
      return {
        added: (total?.added ?? 0) + diff.added,
        removed: (total?.removed ?? 0) + diff.removed,
      };
    }, undefined);
}

/** A task list is complete when it has tasks, every one is closed, and at least one completed. */
export function teamTasksComplete(tasks: readonly TeamTask[]): boolean {
  return (
    tasks.length > 0 &&
    tasks.every((task) => !isTeamTaskOpen(task)) &&
    tasks.some(({ status }) => status === "completed")
  );
}

/**
 * Who a task edit wakes, and what changed for them: a task's new assignee, and its assignee
 * whenever anyone else changes its work, as editing, sending back, closing, reassigning, or
 * removing it does. Closing a task in review wakes no one, since its assignee has moved on; moving
 * a task only arranges the list; and an editor is never woken by its own change.
 */
export function teamTaskNotifications(
  before: readonly TeamTask[],
  after: readonly TeamTask[],
  editorId: string,
): { agentId: string; taskId: string; change: string }[] {
  const previous = new Map(before.map((task) => [task.id, task]));
  const kept = new Set(after.map(({ id }) => id));
  const notifications: { agentId: string; taskId: string; change: string }[] = [];
  const notify = (agentId: string | undefined, taskId: string, change: string) => {
    if (agentId && agentId !== editorId) notifications.push({ agentId, taskId, change });
  };
  for (const task of after) {
    const was = previous.get(task.id);
    if (task.assigneeId !== was?.assigneeId) {
      notify(task.assigneeId, task.id, "assigned to you");
      notify(was?.assigneeId, task.id, "no longer assigned to you");
    } else if (was && changedWork(was, task)) {
      if (!isTeamTaskOpen(task)) {
        if (was.status !== "in_review")
          notify(task.assigneeId, task.id, `closed as ${task.status}`);
      } else {
        notify(
          task.assigneeId,
          task.id,
          task.status === was.status ? "edited" : `moved to ${task.status}`,
        );
      }
    }
  }
  for (const task of before) if (!kept.has(task.id)) notify(task.assigneeId, task.id, "removed");
  return notifications;
}

/** Whether the work a task asks for changed, as opposed to where it sits or when. */
function changedWork(before: TeamTask, after: TeamTask): boolean {
  return (
    (["title", "description", "status", "priority", "artifactId"] as const).some(
      (key) => before[key] !== after[key],
    ) || JSON.stringify(before.diff) !== JSON.stringify(after.diff)
  );
}

/** Whether text cites a task by its whole ID, as agents name tasks such as t12 in messages. */
export function mentionsTeamTask(text: string, taskId: string): boolean {
  for (let at = text.indexOf(taskId); at >= 0; at = text.indexOf(taskId, at + 1)) {
    if (!isIdCharacter(text[at - 1]) && !isIdCharacter(text[at + taskId.length])) return true;
  }
  return false;
}

const isIdCharacter = (character: string | undefined) =>
  character !== undefined && /[\w-]/.test(character);

const MAX_SUBTASKS = 50;
export const teamTaskIdSchema = z.string().trim().min(1).max(255);
const agentIdSchema = z.string().trim().min(1).max(255);
const taskTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  .describe("A concise outcome, without status narrative.");
const taskDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .describe(
    "Markdown under the headings that help: Overview, Why, Approach, and Alternatives and trade-offs. At most 2,000 characters; link a brief for deeper design.",
  );
const taskArtifactIdSchema = z
  .string()
  .min(1)
  .describe(
    "The artifactId of this task's own outcome, returned by sharing or reading an artifact in this team. Do not copy subtask artifact references to a parent.",
  );
const taskDiffSchema = diffStatsSchema.describe(
  "Measured lines directly attributed to this task. Exclude subtask counts; parent totals are computed automatically.",
);

const newTeamTaskSchema = z
  .object({
    title: taskTitleSchema,
    description: taskDescriptionSchema.optional(),
    priority: teamTaskPrioritySchema.optional().describe("Omit for normal."),
    assigneeId: agentIdSchema
      .optional()
      .describe("The agentId of the one team agent directly responsible for it."),
    get children() {
      return z.array(newTeamTaskSchema).max(MAX_SUBTASKS).optional().describe("Subtasks to open.");
    },
  })
  .strict();
type NewTeamTask = z.output<typeof newTeamTaskSchema>;

const taskNoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(3_000)
  .describe(
    "Posts into the task's thread in this same change, saying what changed and why. At most 3,000 characters.",
  );

const taskPatchSchema = z
  .object({
    title: taskTitleSchema.optional(),
    description: taskDescriptionSchema.nullable().optional(),
    status: teamTaskStatusSchema.optional(),
    priority: teamTaskPrioritySchema.optional(),
    artifactId: taskArtifactIdSchema.nullable().optional(),
    diff: taskDiffSchema.nullable().optional(),
  })
  .strict()
  .refine(hasChanges, { message: "Change at least one task field." });

export const editTeamTasksInputSchema = z
  .object({
    operations: z
      .array(
        z.discriminatedUnion("type", [
          newTeamTaskSchema
            .extend({
              type: z.literal("add"),
              parentId: teamTaskIdSchema.optional().describe("Omit to open a top-level task."),
              note: taskNoteSchema.optional(),
            })
            .strict()
            .describe("Opens a pending task, numbered by the server, with optional subtasks."),
          z
            .object({
              type: z.literal("update"),
              taskId: teamTaskIdSchema,
              patch: taskPatchSchema.describe(
                "Omitted fields stay unchanged. Null clears an optional field.",
              ),
              note: taskNoteSchema.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("assign"),
              taskId: teamTaskIdSchema,
              assigneeId: agentIdSchema.nullable().describe("Null leaves the task unassigned."),
              note: taskNoteSchema.optional(),
            })
            .strict(),
          z
            .object({
              type: z.literal("move"),
              taskId: teamTaskIdSchema,
              parentId: teamTaskIdSchema.optional().describe("Omit to move it to the top level."),
            })
            .strict()
            .describe(
              "Moves the existing subtree intact. Its new parent must be outside that subtree.",
            ),
          z
            .object({ type: z.literal("remove"), taskId: teamTaskIdSchema })
            .strict()
            .describe("Removes a mistaken task and its subtasks; close unwanted work instead."),
        ]),
      )
      .min(1)
      .describe("Applied in order as one atomic edit."),
  })
  .strict();

export type EditTeamTasksInput = z.output<typeof editTeamTasksInputSchema>;
type TeamTaskEdit = EditTeamTasksInput["operations"][number];

/**
 * How many reports in a row can continue a task later. A report that doesn't continue resets the
 * count, so a task can't keep waking its assignee on its own.
 */
export const TEAM_TASK_CONTINUE_LIMIT = 3;

/** A turn's report on one task: its status afterward and a note, and when to continue it. */
export const teamTaskReportSchema = z
  .object({
    taskId: teamTaskIdSchema,
    status: teamTaskStatusSchema.describe(
      "The task's status after this turn: in_progress while work remains, blocked when it can't continue, or in_review to hand it off when your part is done.",
    ),
    note: taskNoteSchema.describe(
      "What this turn did and what comes next: what blocks it, or for in_review how it should close. Posts into the task's thread. At most 3,000 characters.",
    ),
    continueAfterMinutes: z
      .number()
      .int()
      .min(5)
      .max(120)
      .optional()
      .describe(
        `With in_progress: wake after this many minutes to keep working on it, unless something wakes you first. At most ${TEAM_TASK_CONTINUE_LIMIT} reports in a row can continue a task.`,
      ),
  })
  .strict()
  .refine(
    ({ status, continueAfterMinutes }) =>
      continueAfterMinutes === undefined || status === "in_progress",
    { message: "Only an in_progress report continues later." },
  );
export type TeamTaskReport = z.output<typeof teamTaskReportSchema>;

/** The tasks a turn reports on: the agent's own that woke it, while they're still open. */
export function teamTurnReportsDue(
  tasks: readonly TeamTask[],
  agentId: string,
  turnTasks: readonly string[] = [],
): TeamTask[] {
  return tasks.filter(
    (task) => turnTasks.includes(task.id) && task.assigneeId === agentId && isTeamTaskOpen(task),
  );
}

/** A finish reports on every task its turn is due to, each once. */
export function assertTeamTurnReports(
  due: readonly TeamTask[],
  reports: readonly Pick<TeamTaskReport, "taskId">[],
): void {
  const reported = new Set<string>();
  for (const { taskId } of reports) {
    if (reported.has(taskId)) throw new Error(`Report on ${taskId} once.`);
    reported.add(taskId);
  }
  const missing = due.filter(({ id }) => !reported.has(id)).map(({ id }) => id);
  if (missing.length) {
    throw new Error(
      `This turn was woken for ${missing.join(", ")}. Report on each in tasks with its status and a note before you finish.`,
    );
  }
}

/** The pending task an agent takes up next: its highest-priority one. */
export function nextTeamTask(tasks: readonly TeamTask[], agentId: string): TeamTask | undefined {
  return teamTasksByPriority(tasks).find(
    (task) => task.assigneeId === agentId && task.status === "pending",
  );
}

/** The agent editing tasks: the lead edits any task, and an assignee only its own. */
export type TeamTaskEditor = { agentId: string; isLead: boolean };

/**
 * Applies an ordered batch to a team's tasks and returns the result, the tasks it opened, each
 * note with the task whose thread it posts into, and the counter after numbering. Each operation
 * leaves a valid tree; the caller commits only the end.
 */
export function applyTeamTaskEdits(
  tasks: readonly TeamTask[],
  operations: readonly TeamTaskEdit[],
  context: { editor: TeamTaskEditor; now: string; lastTaskNumber: number },
): {
  tasks: TeamTask[];
  opened: TeamTask[];
  notes: { taskId: string; note: string }[];
  lastTaskNumber: number;
} {
  const { editor, now } = context;
  let lastTaskNumber = context.lastTaskNumber;
  const opened: TeamTask[] = [];
  const notes: { taskId: string; note: string }[] = [];
  const open = (
    current: TeamTask[],
    parentId: string | undefined,
    task: NewTeamTask,
  ): TeamTask[] => {
    const id = `t${++lastTaskNumber}`;
    const { children = [], priority = "normal", ...fields } = task;
    const next: TeamTask = {
      id,
      ...(parentId ? { parentId } : {}),
      position: nextPosition(current, parentId),
      ...fields,
      // An assignee's subtasks are its own.
      ...(editor.isLead ? {} : { assigneeId: editor.agentId }),
      status: "pending",
      priority,
      openedBy: { type: "agent", agentId: editor.agentId },
      openedAt: now,
      updatedAt: now,
      updatedBy: { type: "agent", agentId: editor.agentId },
    };
    opened.push(next);
    return children.reduce<TeamTask[]>((tree, child) => open(tree, id, child), [...current, next]);
  };

  const result = operations.reduce<TeamTask[]>(
    (current, operation) => {
      assertAuthority(current, operation, editor);
      if ("note" in operation && operation.note) {
        notes.push({
          taskId: operation.type === "add" ? `t${lastTaskNumber + 1}` : operation.taskId,
          note: operation.note,
        });
      }
      switch (operation.type) {
        case "add": {
          const { type: _type, parentId, note: _note, ...task } = operation;
          if (parentId) requireTask(current, parentId);
          return withRoom(open(current, parentId, task), parentId);
        }
        case "update":
          return changeTask(current, operation.taskId, (task) => applyPatch(task, operation.patch));
        case "assign":
          return changeTask(current, operation.taskId, (task) =>
            applyPatch(task, { assigneeId: operation.assigneeId }),
          );
        case "move": {
          const { taskId, parentId } = operation;
          requireTask(current, taskId);
          if (parentId && subtreeIds(current, taskId).has(parentId)) {
            throw new Error(`Move task "${taskId}" outside its own subtree.`);
          }
          if (parentId) requireTask(current, parentId);
          return withRoom(
            changeTask(current, taskId, ({ parentId: _from, ...task }) => ({
              ...task,
              ...(parentId ? { parentId } : {}),
              position: nextPosition(
                current.filter(({ id }) => id !== taskId),
                parentId,
              ),
            })),
            parentId,
          );
        }
        case "remove": {
          requireTask(current, operation.taskId);
          const removed = subtreeIds(current, operation.taskId);
          return current.filter(({ id }) => !removed.has(id));
        }
      }
    },
    [...tasks],
  );
  // Only the end of the batch counts, so a change and its undo leave a task untouched.
  const before = new Map(tasks.map((task) => [task.id, task]));
  const missing = notes.find(({ taskId }) => !result.some(({ id }) => id === taskId));
  if (missing) throw new Error(`Task "${missing.taskId}" was removed, so it can't take a note.`);
  return {
    tasks: result.map((task) => {
      const previous = before.get(task.id);
      return previous
        ? stamp(previous, task, now, { type: "agent", agentId: editor.agentId })
        : task;
    }),
    opened,
    notes,
    lastTaskNumber,
  };
}

/**
 * The lead edits any task. An assignee adds subtasks, assigned to itself, under its own open tasks
 * and updates its own open tasks up to handing them off for review; it proposes everything else.
 */
function assertAuthority(
  tasks: readonly TeamTask[],
  operation: TeamTaskEdit,
  editor: TeamTaskEditor,
): void {
  if (editor.isLead) return;
  const own = (taskId: string | undefined) => {
    const task = taskId === undefined ? undefined : requireTask(tasks, taskId);
    return task?.assigneeId === editor.agentId && isTeamTaskOpen(task);
  };
  switch (operation.type) {
    case "add": {
      if (!own(operation.parentId)) {
        throw new Error(
          "Add subtasks only under your own open tasks. Mention the lead in the task's thread to propose other work.",
        );
      }
      const assignees = (task: NewTeamTask): (string | undefined)[] => [
        task.assigneeId,
        ...(task.children ?? []).flatMap(assignees),
      ];
      if (assignees(operation).some((id) => id !== undefined && id !== editor.agentId)) {
        throw new Error(
          "Your subtasks are assigned to you. Mention the lead in the task's thread to propose work for someone else.",
        );
      }
      return;
    }
    case "update":
      if (!own(operation.taskId)) throw new Error("Update only your own open tasks.");
      if (operation.patch.status && teamTaskState(operation.patch.status) === "closed") {
        throw new Error(
          "Only the lead closes a task. Hand it off with status in_review and say in your note how it should close.",
        );
      }
      return;
    default:
      throw new Error(
        `Only the lead can ${operation.type} tasks. Mention the lead in the task's thread to propose it.`,
      );
  }
}

/** Records when a task changed and who changed it, and when it closed; reopening clears that. */
function stamp(previous: TeamTask, next: TeamTask, now: string, by: TeamMessageActor): TeamTask {
  if (sameTask(previous, next)) return previous;
  const { closedAt: _closedAt, ...task } = next;
  const closedAt = isTeamTaskOpen(next)
    ? undefined
    : isTeamTaskOpen(previous)
      ? now
      : previous.closedAt;
  return { ...task, updatedAt: now, updatedBy: by, ...(closedAt ? { closedAt } : {}) };
}

function sameTask(left: TeamTask, right: TeamTask): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof TeamTask>;
  return [...keys].every((key) => {
    const [a, b] = [left[key], right[key]];
    return typeof a === "object" && typeof b === "object"
      ? JSON.stringify(a) === JSON.stringify(b)
      : a === b;
  });
}

function changeTask(
  tasks: readonly TeamTask[],
  taskId: string,
  change: (task: TeamTask) => TeamTask,
): TeamTask[] {
  requireTask(tasks, taskId);
  return tasks.map((task) => (task.id === taskId ? change(task) : task));
}

function requireTask(tasks: readonly TeamTask[], taskId: string): TeamTask {
  const task = tasks.find(({ id }) => id === taskId);
  if (!task) throw new Error(`Task "${taskId}" was not found in this team.`);
  return task;
}

function nextPosition(tasks: readonly TeamTask[], parentId: string | undefined): number {
  return (
    Math.max(-1, ...tasks.filter((task) => task.parentId === parentId).map((t) => t.position)) + 1
  );
}

function withRoom(tasks: TeamTask[], parentId: string | undefined): TeamTask[] {
  const siblings = tasks.filter((task) => task.parentId === parentId).length;
  if (siblings > MAX_SUBTASKS) {
    throw new Error(
      `${parentId ? `Task "${parentId}"` : "The top level"} already holds ${MAX_SUBTASKS} tasks. Group them into a milestone first.`,
    );
  }
  return tasks;
}

function subtreeIds(tasks: readonly TeamTask[], taskId: string): Set<string> {
  const ids = new Set([taskId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const { id, parentId } of tasks) {
      if (parentId && ids.has(parentId) && !ids.has(id)) {
        ids.add(id);
        grew = true;
      }
    }
  }
  return ids;
}
