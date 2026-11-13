import type {
  ProposeTeamAdviceInput,
  ResolveTeamAdviceInput,
  TeamAdvice,
  TeamAdviceAction,
} from "@teams/model/advice";
import { getStateDatabase } from "@/server/database";
import { TeamDatabase } from "./database";
import { moveTeamMembers, postTeamMessage, publishTeamChange } from "./index";

/** Records advice an agent proposes, once its action names real members and teams. */
export async function proposeTeamAdviceFromAgent(
  sessionId: string,
  input: ProposeTeamAdviceInput,
): Promise<TeamAdvice> {
  const database = new TeamDatabase(await getStateDatabase());
  const agent = await database.getAgent(sessionId);
  if (!agent) throw new Error("This agent session does not belong to a team.");
  await assertAdviceAction(database, agent.teamId, input.action);
  const change = await database.proposeAdvice(sessionId, input);
  publishTeamChange(change);
  return change.advice;
}

/**
 * The user applies or dismisses open advice. Applying claims it first, so a second click acts
 * once, then carries out its action with the user's authority, reopening it if the action fails.
 */
export async function resolveTeamAdvice({
  teamId,
  adviceId,
  resolution,
}: ResolveTeamAdviceInput): Promise<TeamAdvice> {
  const database = new TeamDatabase(await getStateDatabase());
  const claimed = await database.setAdviceStatus(
    teamId,
    adviceId,
    resolution === "apply" ? "applied" : "dismissed",
  );
  if (!claimed) throw new Error("This advice was already resolved.");
  publishTeamChange(claimed);
  if (resolution === "dismiss") return claimed.advice;
  try {
    await assertAdviceAction(database, teamId, claimed.advice.action);
    await applyAdviceAction(teamId, claimed.advice);
  } catch (error) {
    const reopened = await database.setAdviceStatus(teamId, adviceId, "open");
    if (reopened) publishTeamChange(reopened);
    throw error;
  }
  return claimed.advice;
}

async function applyAdviceAction(teamId: string, { title, action }: TeamAdvice): Promise<void> {
  switch (action.type) {
    case "message_lead":
      await postTeamMessage({
        id: crypto.randomUUID(),
        teamId,
        content: `@lead Please apply this advice, "${title}": ${action.content}`,
      });
      return;
    case "move_members":
      await moveTeamMembers({ teamId, agentIds: action.agentIds, to: action.to });
      return;
  }
}

/** Advice can only move the team's current members, never its lead, to another team. */
async function assertAdviceAction(
  database: TeamDatabase,
  teamId: string,
  action: TeamAdviceAction,
): Promise<void> {
  if (action.type !== "move_members") return;
  const members = new Set((await database.listMembers(teamId)).map(({ id }) => id));
  if (action.agentIds.some((id) => !members.has(id))) {
    throw new Error("Advice can move only this team's current members, never its lead.");
  }
  if ("teamId" in action.to) {
    if (action.to.teamId === teamId) throw new Error("Move members to a different team.");
    if (!(await database.getTeam(action.to.teamId))) throw new Error("The target team is gone.");
  }
}
