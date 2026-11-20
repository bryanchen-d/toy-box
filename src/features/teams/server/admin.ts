import { getStateDatabase } from "@/server/database";
import { getSettings } from "@workspace/server/state/settings";
import { broadcast } from "@workspace/server/events";
import { listModels } from "@providers/server";
import { normalizeModelConfiguration } from "@providers/model";
import { createSessionRecord } from "@sessions/server/state/registry";
import { readSession } from "@sessions/server/state/sessions";
import type { SessionStall } from "@sessions/server/runtime";
import { createWorker, getPersistedWorker } from "@workers/server/database";
import { sharedMap } from "@/shared/server/processState";
import { teamHandle, type Team } from "@teams/model";
import { ADMIN_TEAM_AVATAR, ADMIN_TEAM_ID, ADMIN_TEAM_PURPOSE } from "@teams/model/admin";
import { TeamDatabase } from "./database";
import { publishTeamChange, wakeTeamAgent } from "./index";

const provisioning = sharedMap<Promise<Team | null>>("admin-team-provisioning");

/** Reserve the ordinary team and lead without starting a provider or spending model credits. */
export function ensureAdminTeam(): Promise<Team | null> {
  const pending = provisioning.get("workspace");
  if (pending) return pending;
  const operation = provision().finally(() => provisioning.delete("workspace"));
  provisioning.set("workspace", operation);
  return operation;
}

async function provision(): Promise<Team | null> {
  const database = new TeamDatabase(await getStateDatabase());
  let team = await database.getTeam(ADMIN_TEAM_ID);
  const created = !team;
  if (!team) {
    const [models, settings] = await Promise.all([listModels(), getSettings()]);
    // Provider setup may not be complete on a fresh machine. Retry at the next catalog read.
    if (models.length === 0) return null;
    const model = normalizeModelConfiguration(models, settings.defaultModel);
    if (!model) throw new Error("An available model is required to provision the Admin team.");
    const handles = new Set((await database.listTeams()).teams.map(teamHandle));
    let name = "Admin";
    for (let suffix = 2; handles.has(teamHandle({ name })); suffix++) name = `Admin ${suffix}`;
    const lead = createWorker(
      {
        type: "team",
        teamId: ADMIN_TEAM_ID,
        ephemeral: false,
        name: `Lead · ${name}`,
        metadata: { seenThrough: 0 },
      },
      ADMIN_TEAM_ID,
    );
    team = await database.createTeam({ name, purpose: ADMIN_TEAM_PURPOSE, model }, lead);
  }
  if (!(await readSession(ADMIN_TEAM_ID))) {
    await createSessionRecord(ADMIN_TEAM_ID, { sessionType: "worker", title: "Admin lead" });
  }
  const initialized = await database.initializeAvatar(ADMIN_TEAM_ID, ADMIN_TEAM_AVATAR);
  team = initialized.team;
  if (created) broadcast({ type: "team.upserted", team });
  else publishTeamChange(initialized);
  return team;
}

/**
 * Tell Admin about a session waiting on a provider that stopped answering, so its lead can confirm
 * it and ask the owner to stop it. Nothing is stopped here.
 */
export async function noteStalledSession(stall: SessionStall): Promise<void> {
  const database = new TeamDatabase(await getStateDatabase());
  if (!(await database.getTeam(ADMIN_TEAM_ID))) return;
  const agent = await database.getAgent(stall.sessionId);
  const team = agent && (await database.getTeam(agent.teamId));
  const name = agent?.name ?? (await getPersistedWorker(stall.sessionId))?.name;
  const change = await database.noteSessionStalled(ADMIN_TEAM_ID, {
    type: "session_stalled",
    sessionId: stall.sessionId,
    ...(name ? { name } : {}),
    ...(team ? { team: { id: team.id, name: team.name } } : {}),
    since: stall.since,
    queuedMessages: stall.queuedMessages,
  });
  publishTeamChange(change);
  if (change.events.length)
    await wakeTeamAgent(ADMIN_TEAM_ID, { type: "team_message", senderName: "Agent Teams" });
}

/** Tool exposure is convenience; invocation identity is the server-side authority. */
export async function requireAdminLead(sessionId: string): Promise<void> {
  if (sessionId !== ADMIN_TEAM_ID)
    throw new Error("Only the built-in Admin lead can administer sessions.");
  const worker = await getPersistedWorker(sessionId);
  const team = await new TeamDatabase(await getStateDatabase()).getTeam(ADMIN_TEAM_ID);
  if (worker?.type !== "team" || worker.teamId !== ADMIN_TEAM_ID || !team)
    throw new Error("The built-in Admin lead is unavailable.");
  if (team.paused) throw new Error("Resume the Admin team before administering sessions.");
}
