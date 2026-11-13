import {
  aggregate,
  EMPTY_DELIVERIES,
  nextBucketStart,
  performanceWindow,
  projectTeamPerformance,
  USER_AUTHOR,
  type Deliveries,
  type PerformanceBucket,
  type TeamPerformance,
} from "@teams/model/performance";
import { listSessionActivity } from "@sessions/server/activity";
import { getStateDatabase } from "@/server/database";
import { TeamDatabase } from "./database";

/** The team's performance over the window `bucket` covers, ending now. */
export async function getTeamPerformance(
  teamId: string,
  bucket: PerformanceBucket,
  now = new Date(),
): Promise<TeamPerformance> {
  const database = new TeamDatabase(await getStateDatabase());
  const roster = await database.getRoster(teamId);
  if (!roster) throw new Error("Team not found.");
  const starts = performanceWindow(now, bucket);
  const from = starts[0]!;
  const to = nextBucketStart(starts.at(-1)!, bucket);
  // Activity outlives membership, so a removed or moved agent's hours count only while it's here.
  const agentIds = [roster.lead, ...roster.members].map(({ id }) => id);
  const [messages, wakes, activity] = await Promise.all([
    database.listConversationSince(teamId, from.toISOString()),
    database.listWakesSince(teamId, from.toISOString()),
    listSessionActivity(agentIds, from, to),
  ]);
  return projectTeamPerformance(messages, {
    lead: roster.lead,
    members: roster.members,
    bucket,
    starts,
    wakes,
    activity,
  });
}

/** What an agent reads of its own team's performance, named rather than identified. */
export async function readTeamPerformanceForAgent(sessionId: string, bucket: PerformanceBucket) {
  const database = new TeamDatabase(await getStateDatabase());
  const agent = await database.getAgent(sessionId);
  if (!agent) throw new Error("This agent session does not belong to a team.");
  const { listConnectors } = await import("@connectors/server");
  const [performance, roster, advice, { teams }, connectors] = await Promise.all([
    getTeamPerformance(agent.teamId, bucket),
    database.getRoster(agent.teamId),
    database.listAdvice(agent.teamId),
    database.listTeams(),
    listConnectors(),
  ]);
  const names = new Map<string, string>([
    [USER_AUTHOR, "the user"],
    ...teams.map(({ id, name }) => [id, `team ${name}`] as const),
    ...connectors.map(({ id, name }) => [id, name] as const),
    ...[roster!.lead, ...roster!.members].map(({ id, name }) => [id, name] as const),
  ]);
  const name = (id: string) => names.get(id) ?? "a former member";
  const total = (values: Record<string, number>) =>
    Object.values(values).reduce((sum, value) => sum + value, 0);
  const deliveries = (values: Record<string, Deliveries>) =>
    Object.values(values).reduce(
      (sum, { started, steered, queued }) => ({
        started: sum.started + started,
        steered: sum.steered + steered,
        queued: sum.queued + queued,
      }),
      { ...EMPTY_DELIVERIES },
    );
  return {
    bucket,
    from: performance.from,
    to: performance.to,
    deliveries:
      "started: the wake began a turn while the agent was idle. steered: it interrupted the agent's running turn with the prompt. queued: it waited for that turn to end.",
    agents: performance.agents.map(({ agentId, ...stats }) => ({
      agentId,
      name: name(agentId),
      ...stats,
    })),
    series: performance.series.map(
      ({ start, messages, wakes, deliveries: byAgent, responses, runtime }) => ({
        start,
        messages: total(messages),
        notifications: total(wakes),
        deliveries: deliveries(byAgent),
        medianResponseMs: aggregate(Object.values(responses).flat(), "p50"),
        aiCredits: Object.values(runtime).reduce((sum, { aiCredits }) => sum + aiCredits, 0),
        busyMs: Object.values(runtime).reduce((sum, { busyMs }) => sum + busyMs, 0),
      }),
    ),
    addresses: performance.addresses.map(({ from, to, ...pair }) => ({
      from: name(from),
      to: name(to),
      ...pair,
    })),
    advice: advice.map(({ id, title, status, action }) => ({
      adviceId: id,
      title,
      status,
      action: action.type,
    })),
  };
}
