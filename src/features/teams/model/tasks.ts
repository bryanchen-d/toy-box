import { z } from "zod";
import { diffStatsSchema, type DiffStats } from "@/shared/diffStats";
import { applyPatch, hasChanges } from "./changes";

const taskIdSchema = z.string().trim().min(1).max(255);

export const teamTaskSchema = z
  .object({
    id: taskIdSchema.describe(
      "A short stable ID unique within the team, such as t1 or t12. Preserve it when editing.",
    ),
    title: z.string().trim().min(1).max(240).describe("A concise outcome or next step."),
    status: z.enum(["pending", "in_progress", "blocked", "done"]),
    ownerId: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe("The team lead ID or current member ID responsible for the task."),
    artifactId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The artifactId of this task's own outcome, returned by sharing or reading an artifact in this team. Do not copy subtask artifact references to a parent.",
      ),
    diff: diffStatsSchema
      .optional()
      .describe(
        "Measured lines directly attributed to this task. Exclude subtask counts; parent totals are computed automatically.",
      ),
    get children() {
      return z.array(teamTaskSchema).max(50).optional().describe("Optional subtasks.");
    },
  })
  .strict();

export type TeamTask = z.output<typeof teamTaskSchema>;

export const teamTasksSchema = z
  .array(teamTaskSchema)
  .max(50)
  .superRefine((tasks, context) => {
    const ids = new Set<string>();
    const visit = (tasks: readonly TeamTask[], path: (string | number)[]) => {
      tasks.forEach((task, index) => {
        if (ids.has(task.id)) {
          context.addIssue({
            code: "custom",
            message: `Task ID "${task.id}" is already in use in this team.`,
            path: [...path, index, "id"],
          });
        }
        ids.add(task.id);
        if (task.children) visit(task.children, [...path, index, "children"]);
      });
    };
    visit(tasks, []);
  });

export function teamTasksForAgent(tasks: readonly TeamTask[], agentId: string): TeamTask[] {
  return tasks.flatMap((task) => [
    ...(task.ownerId === agentId ? [task] : []),
    ...teamTasksForAgent(task.children ?? [], agentId),
  ]);
}

/** Sum reported work across task trees without storing derived totals. */
export function teamTasksDiff(tasks: readonly TeamTask[]): DiffStats | undefined {
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

const taskPatchSchema = teamTaskSchema
  .omit({ id: true, children: true })
  .partial()
  .extend({
    ownerId: teamTaskSchema.shape.ownerId.nullable(),
    artifactId: teamTaskSchema.shape.artifactId.nullable(),
    diff: teamTaskSchema.shape.diff.nullable(),
  })
  .refine(hasChanges, { message: "Change at least one task field." });

export const editTeamTasksInputSchema = z
  .object({
    operations: z
      .array(
        z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("add"),
              parentId: taskIdSchema.optional().describe("Omit to append a top-level task."),
              task: teamTaskSchema,
            })
            .strict(),
          z
            .object({
              type: z.literal("update"),
              taskId: taskIdSchema,
              patch: taskPatchSchema.describe(
                "Omitted fields and children stay unchanged. Null clears an optional field.",
              ),
            })
            .strict(),
          z.object({ type: z.literal("remove"), taskId: taskIdSchema }).strict(),
          z
            .object({
              type: z.literal("move"),
              taskId: taskIdSchema,
              parentId: taskIdSchema.optional().describe("Omit to append a top-level task."),
            })
            .strict()
            .describe(
              "Move the existing subtree intact. Its new parent must be outside that subtree.",
            ),
        ]),
      )
      .min(1)
      .describe("Applied in order as one atomic edit. Removing a task removes its subtree."),
  })
  .strict();

export type EditTeamTasksInput = z.output<typeof editTeamTasksInputSchema>;

/** Each operation preserves a valid tree; the caller commits only the final result. */
export function applyTeamTaskEdits(
  tasks: readonly TeamTask[],
  operations: EditTeamTasksInput["operations"],
): TeamTask[] {
  return operations.reduce<TeamTask[]>(
    (current, operation) => {
      switch (operation.type) {
        case "add":
        case "move": {
          const inserted = operation.type === "add" ? [operation.task] : [];
          // Detaching first makes self and descendant destinations unreachable.
          const remaining =
            operation.type === "move"
              ? changeTask(current, operation.taskId, (task) => {
                  inserted.push(task);
                  return null;
                })
              : current;
          return teamTasksSchema.parse(
            operation.parentId
              ? changeTask(remaining, operation.parentId, (parent) => ({
                  ...parent,
                  children: [...(parent.children ?? []), ...inserted],
                }))
              : [...remaining, ...inserted],
          );
        }
        case "update":
          return changeTask(current, operation.taskId, (task) => applyPatch(task, operation.patch));
        case "remove":
          return changeTask(current, operation.taskId, () => null);
      }
    },
    [...tasks],
  );
}

function changeTask(
  tasks: readonly TeamTask[],
  taskId: string,
  change: (task: TeamTask) => TeamTask | null,
): TeamTask[] {
  let found = false;
  const visit = (tasks: readonly TeamTask[]): TeamTask[] =>
    tasks.flatMap((task) => {
      if (task.id === taskId) {
        found = true;
        const next = change(task);
        return next ? [next] : [];
      }
      return [task.children ? { ...task, children: visit(task.children) } : task];
    });
  const next = visit(tasks);
  if (!found) throw new Error(`Task "${taskId}" was not found in this team.`);
  return next;
}

export function unassignTeamTasks(tasks: readonly TeamTask[], agentId: string): TeamTask[] {
  return tasks.map(({ ownerId, children, ...task }) => ({
    ...task,
    ...(ownerId && ownerId !== agentId ? { ownerId } : {}),
    ...(children ? { children: unassignTeamTasks(children, agentId) } : {}),
  }));
}

/** A task list is complete when it has tasks and every task and subtask is done. */
export function teamTasksComplete(tasks: readonly TeamTask[]): boolean {
  const allDone = (tasks: readonly TeamTask[]): boolean =>
    tasks.every(({ status, children = [] }) => status === "done" && allDone(children));
  return tasks.length > 0 && allDone(tasks);
}
