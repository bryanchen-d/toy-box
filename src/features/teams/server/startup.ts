import { getStateDatabase } from "@/server/database";
import type { SessionCompletion } from "@sessions/model";
import { subscribeSessionCompletions, subscribeSessionStalls } from "@sessions/server/runtime";
import { subscribeWorkspaceEvents } from "@workspace/server/events";
import { getSessionState } from "@workspace/server/state/sessions";
import { WorkerDatabase } from "@workers/server/database";
import { TeamDatabase } from "./database";
import { endTeamAgentTurn, publishTeamChange, wakeDueTeamAgents } from "./index";
import { ensureAdminTeam, noteStalledSession } from "./admin";

/**
 * Working status belongs to an execution; waiting survives it and can schedule a wake. A turn that
 * ends without reporting on the tasks it was woken for, including one the server's last stop
 * interrupted, is settled once it ends.
 */
export default async function startTeams(): Promise<VoidFunction> {
  const db = await getStateDatabase();
  const teams = new TeamDatabase(db);
  await ensureAdminTeam();
  const unsubscribeStalls = subscribeSessionStalls((stall) => {
    void noteStalledSession(stall).catch((error: unknown) =>
      console.error(`Could not tell Admin that session ${stall.sessionId} stalled:`, error),
    );
  });
  // An execution that ends on its own or with an error publishes its completion right after its
  // idle status, in the same step; a stopped one publishes none.
  const completions = new Map<string, SessionCompletion>();
  const unsubscribeCompletions = subscribeSessionCompletions((sessionId, completion) => {
    completions.set(sessionId, completion);
    queueMicrotask(() => completions.delete(sessionId));
  });
  const unsubscribe = subscribeWorkspaceEvents((event) => {
    if (event.type === "providers.changed" || event.type === "settings.changed") {
      void ensureAdminTeam().catch((error: unknown) =>
        console.error("Failed to provision the Admin team:", error),
      );
    }
    if (event.type === "session.idle" || event.type === "session.unread") {
      void clearWorkingStatus(event.sessionId);
      const { sessionId } = event;
      queueMicrotask(() => {
        const completion = completions.get(sessionId);
        void endTurn(
          sessionId,
          !completion ? "stopped" : completion.status === "completed" ? "unreported" : "failed",
          completion?.error,
        );
      });
    }
  });
  for (const worker of await new WorkerDatabase(db).list("team")) {
    const status = getSessionState(worker.sessionId)?.status;
    if (status !== "running" && status !== "waiting") {
      await clearWorkingStatus(worker.sessionId);
      await endTurn(worker.sessionId, "stopped");
    }
  }
  const timer = setInterval(() => void wakeDueTeamAgents(), 30_000);
  timer.unref?.();
  return () => {
    unsubscribeStalls();
    unsubscribeCompletions();
    unsubscribe();
    clearInterval(timer);
  };

  function clearWorkingStatus(agentId: string) {
    // Enqueue synchronously so a subsequent turn's status write follows this clear.
    return teams
      .clearAgentStatus(agentId, "working")
      .then((change) => {
        if (change) publishTeamChange(change);
      })
      .catch((error: unknown) => console.error("Failed to clear Team working status:", error));
  }

  function endTurn(agentId: string, outcome: "unreported" | "failed" | "stopped", error?: string) {
    // Enqueued before any later wake can add the next turn's tasks.
    return endTeamAgentTurn(teams, agentId, outcome, error).catch((error: unknown) =>
      console.error(`Failed to settle Team agent ${agentId}'s turn:`, error),
    );
  }
}
