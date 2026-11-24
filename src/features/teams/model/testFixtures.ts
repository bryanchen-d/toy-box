import type { TeamTask } from ".";

/** A pending, normal-priority task the lead opened, with any fields a test sets. */
export function teamTask(id: string, fields: Partial<TeamTask> = {}): TeamTask {
  return {
    id,
    position: 0,
    title: id,
    status: "pending",
    priority: "normal",
    openedBy: { type: "agent", agentId: "team" },
    openedAt: "2026-11-24T10:00:00.000Z",
    updatedAt: "2026-11-24T10:00:00.000Z",
    ...fields,
  };
}
