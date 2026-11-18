import { readSessions } from "@sessions/server/state/sessions";
import { getSessionConnectionStatus } from "@sessions/server/state/registry";
import { getSessionRuntimeDiagnostics, getSessionRuntimeIds } from "@sessions/server/runtime";
import type { SessionStatusInput } from "@sessions/model/protocol";
import { TeamDatabase } from "@teams/server/database";
import { getSessionStates } from "@workspace/server/state/sessions";
import { getHyperSessionIds } from "@workspace/server/state/hyperSessions";
import { getStateDatabase } from "./database";
import { readSessionCatalog } from "./managedSessions";

/** Owner-facing metadata only: no provider discovery, history replay, or session execution. */
export async function checkSessionStatus({
  sessionId,
  limit = 50,
  offset = 0,
}: SessionStatusInput) {
  const database = await getStateDatabase({ createIfMissing: false });
  const [catalog, teamList] = await Promise.all([
    readSessionCatalog(async () => [await readSessions(), {}]),
    database ? new TeamDatabase(database).listTeams() : { teams: [], members: [] },
  ]);
  const sessions = new Map(catalog.sessions.map((session) => [session.id, session]));
  const teams = new Map(teamList.teams.map((team) => [team.id, team]));
  const members = new Map(teamList.members.map((member) => [member.id, member]));
  const hyperIds = new Set(getHyperSessionIds());
  const workspace = getSessionStates();
  const ids = new Set([
    ...sessions.keys(),
    ...Object.keys(catalog.ownership),
    ...Object.keys(workspace),
    ...hyperIds,
    ...getSessionRuntimeIds(),
  ]);
  const observedAt = Date.now();

  function summary(id: string) {
    const session = sessions.get(id);
    const ownership = catalog.ownership[id];
    const member = members.get(id);
    const team = teams.get(member?.teamId ?? id);
    const shared = workspace[id];
    return {
      sessionId: id,
      type: ownership?.type ?? (hyperIds.has(id) ? "hyper" : "standard"),
      provider: session?.provider?.id,
      name: team ? (member?.name ?? "Lead") : session?.title,
      parentSessionId: ownership?.type === "worker" ? ownership.parentSessionId : undefined,
      team: team
        ? {
            id: team.id,
            name: team.name,
            role: member ? ("member" as const) : ("lead" as const),
            paused: team.paused,
          }
        : undefined,
      startedAt: shared && "since" in shared ? shared.since : undefined,
      ...getSessionRuntimeDiagnostics(id),
    };
  }

  if (sessionId !== undefined) {
    if (!ids.has(sessionId)) {
      throw new Error(
        "Session not found in the retained local workspace. Use list_sessions to discover native provider history.",
      );
    }
    return {
      observedAt,
      ...summary(sessionId),
      connection: await getSessionConnectionStatus(sessionId),
    };
  }

  const entries = [...ids]
    .map(summary)
    .sort(
      (a, b) => Number(b.running) - Number(a.running) || a.sessionId.localeCompare(b.sessionId),
    );
  const selected = entries.slice(offset, offset + limit);
  return {
    observedAt,
    sessions: await Promise.all(
      selected.map(async (entry) => ({
        ...entry,
        connection: await getSessionConnectionStatus(entry.sessionId),
      })),
    ),
    total: entries.length,
    offset,
    hasMore: offset + selected.length < entries.length,
  };
}
