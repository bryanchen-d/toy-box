import type { TeamAgent } from ".";

/**
 * How an agent appears to the rest of the Team. A running session is working, on the tasks its
 * turn was woken for when there are any. An idle agent can still be waiting on someone. Runtime
 * activity wins while turn-start and turn-end writes settle.
 */
export type TeamAgentPresence =
  | { state: "working"; text?: string; tasks?: string[] }
  | { state: "waiting"; text: string; wakeAt?: string }
  | { state: "idle" };

export function teamAgentPresence(
  { status, turnTasks }: Pick<TeamAgent, "status" | "turnTasks">,
  running: boolean,
): TeamAgentPresence {
  if (running) {
    return {
      state: "working",
      ...(status?.state === "working" ? { text: status.text } : {}),
      ...(turnTasks ? { tasks: turnTasks } : {}),
    };
  }
  return status?.state === "waiting" ? status : { state: "idle" };
}

/** Whether a task's assignee is running a turn woken for it. */
export function isTeamTaskWorkingNow(
  { id, assigneeId }: { id: string; assigneeId?: string },
  presence: Readonly<Record<string, TeamAgentPresence>>,
): boolean {
  const activity = assigneeId ? presence[assigneeId] : undefined;
  return activity?.state === "working" && (activity.tasks?.includes(id) ?? false);
}
