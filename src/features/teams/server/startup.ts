import { getStateDatabase } from "@/server/database";
import { subscribeWorkspaceEvents } from "@workspace/server/events";
import { getSessionState } from "@workspace/server/state/sessions";
import { WorkerDatabase } from "@workers/server/database";
import { TeamDatabase } from "./database";
import { publishTeamChange, wakeDueTeamAgents } from "./index";

/** Working status belongs to an execution; waiting survives it and can schedule a wake. */
export default async function startTeams(): Promise<VoidFunction> {
  const db = await getStateDatabase();
  const teams = new TeamDatabase(db);
  const unsubscribe = subscribeWorkspaceEvents((event) => {
    if (event.type === "session.idle" || event.type === "session.unread") {
      void clearWorkingStatus(event.sessionId);
    }
  });
  for (const worker of await new WorkerDatabase(db).list("team")) {
    const status = getSessionState(worker.sessionId)?.status;
    if (status !== "running" && status !== "waiting") await clearWorkingStatus(worker.sessionId);
  }
  const timer = setInterval(() => void wakeDueTeamAgents(), 30_000);
  timer.unref?.();
  return () => {
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
}
