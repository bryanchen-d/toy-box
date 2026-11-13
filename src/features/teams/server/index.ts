import { isAbsolute, resolve } from "node:path";
import type {
  ArrangeTeamArtifactsInput,
  Team,
  TeamAgentStatus,
  TeamList,
  TeamMember,
  TeamMessage,
  TeamMessageActor,
  TeamReaction,
  TeamRoutine,
  CreateTeamMemberInput,
  CreateTeamInput,
  EditTeamInput,
  EditTeamTasksInput,
  PostTeamMessageInput,
  SetTeamAgentStatusInput,
  SetTeamRoutineInput,
  TeamMemberChanges,
  UpdateTeamInput,
} from "@teams/model";
import {
  teamLead,
  teamMemberIdentity,
  resolveTeamAudience,
  isTeamSystemMessage,
  messageAuthorId,
} from "@teams/model";
import { USER_AUTHOR } from "@teams/model/performance";
import { workspaceFileFromAbsolutePath } from "@files/server/paths";
import {
  abortSession,
  deliverSessionMessage,
  getSessionDirectory,
  getSessionUsage,
  waitForSessions,
} from "@sessions/server/runtime";
import type { SessionSystemMessage } from "@sessions/model";
import { getStateDatabase } from "@/server/database";
import { broadcast } from "@workspace/server/events";
import { deleteSavedDraft } from "@workspace/server/state/drafts";
import { deleteWorker, spawnWorker } from "@workers/server";
import { TeamDatabase, type StoredTeamMessage, type TeamChange } from "./database";
import { resolveMessageResources, resolveEventResources } from "./resources";
import { publishTeamEvent, releaseTeamEvents } from "./events";
import { sharedMap } from "@/shared/server/processState";
import { SerialTaskQueue } from "@/shared/serialTaskQueue";

const TEAM_MESSAGE_LIMIT = 100;
const teamEditQueues = sharedMap<SerialTaskQueue>("team-edit-queues");

export async function listTeams(): Promise<TeamList> {
  return new TeamDatabase(await getStateDatabase()).listTeams();
}

export async function getTeamUsage(teamId: string) {
  const roster = await new TeamDatabase(await getStateDatabase()).getRoster(teamId);
  if (!roster) throw new Error("Team not found.");
  return Object.fromEntries(
    await Promise.all(
      [roster.lead, ...roster.members].map(
        async (agent) => [agent.id, await getSessionUsage(agent.id)] as const,
      ),
    ),
  );
}

export async function createTeamMember({
  teamId,
  name,
  ...profile
}: CreateTeamMemberInput): Promise<TeamMember> {
  const database = new TeamDatabase(await getStateDatabase());
  const { value: member } = await spawnWorker({
    owner: { type: "team", teamId },
    name,
    metadata: { seenThrough: 0, ...profile },
    retention: "durable",
    message: {
      content:
        "You have joined this team. Read its context and complete any missing profile details. If you have been assigned work, begin it. Otherwise finish your turn quietly, without a readiness message or waiting status.",
    },
    admit: async (worker) => {
      const change = await database.createMember(worker);
      publishTeamChange(change);
      return change.member;
    },
  });
  return member;
}

export async function createTeamMembers(
  teamId: string,
  members: readonly Omit<CreateTeamMemberInput, "teamId">[],
): Promise<TeamMember[]> {
  const created: TeamMember[] = [];
  for (const member of members) {
    created.push(await createTeamMember({ ...member, teamId }));
  }
  return created;
}

export async function createTeamMembersFromLead(
  sessionId: string,
  members: readonly Omit<CreateTeamMemberInput, "teamId">[],
): Promise<TeamMember[]> {
  const agent = await requireTeamAgent(new TeamDatabase(await getStateDatabase()), sessionId);
  if (!agent.isLead) throw new Error("Only the team lead can create members.");
  return createTeamMembers(agent.teamId, members);
}

export async function updateTeamMember(
  input: TeamMemberChanges & { agentId: string },
): Promise<TeamMember> {
  const database = new TeamDatabase(await getStateDatabase());
  const { agentId, ...update } = input;
  const change = await database.updateMember(agentId, update);
  publishTeamChange(change);
  return change.member;
}

export async function updateTeamFromLead(sessionId: string, input: UpdateTeamInput) {
  const database = new TeamDatabase(await getStateDatabase());
  if (input.directory && !isAbsolute(input.directory)) {
    throw new Error("Use an absolute working directory.");
  }
  const change = await database.updateTeam(sessionId, input);
  publishTeamChange(change);
  return change.team;
}

export async function editTeamTasksFromLead(
  sessionId: string,
  input: EditTeamTasksInput,
): Promise<void> {
  const change = await new TeamDatabase(await getStateDatabase()).editTasks(sessionId, input);
  publishTeamChange(change);
}

export async function arrangeTeamArtifacts(input: ArrangeTeamArtifactsInput): Promise<void> {
  const change = await new TeamDatabase(await getStateDatabase()).arrangeArtifacts(input);
  publishTeamChange(change);
}

export async function getTeamHistory(teamId: string, beforeSequence: number) {
  const database = new TeamDatabase(await getStateDatabase());
  const page = await database.getHistory(teamId, beforeSequence);
  return page && { ...page, messages: page.messages.map(resolveMessageResources) };
}

export async function createTeam(input: CreateTeamInput): Promise<Team> {
  const teamId = crypto.randomUUID();
  const database = new TeamDatabase(await getStateDatabase());
  const { value: team } = await spawnWorker({
    sessionId: teamId,
    owner: { type: "team", teamId },
    name: `Lead · ${input.name}`,
    metadata: { seenThrough: 0 },
    retention: "durable",
    message: { content: "This team was just created. Begin working toward its purpose." },
    admit: async (lead) => {
      const team = await database.createTeam(input, lead);
      broadcast({ type: "team.upserted", team });
      return team;
    },
  });
  return team;
}

export async function editTeam(input: EditTeamInput): Promise<Team> {
  let queue = teamEditQueues.get(input.teamId);
  if (!queue) {
    queue = new SerialTaskQueue();
    teamEditQueues.set(input.teamId, queue);
  }
  const change = await queue.enqueue(async () => {
    const database = new TeamDatabase(await getStateDatabase());
    const change = await database.editTeam(input);
    publishTeamChange(change);
    if (input.paused === true) {
      const roster = await database.getRoster(input.teamId);
      if (!roster) throw new Error("Team not found.");
      const results = await Promise.allSettled(
        [roster.lead, ...roster.members].map(({ id }) => abortSession(id)),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length)
        throw new AggregateError(errors, "Team paused; some agents could not be stopped.");
    }
    return change;
  });
  if (
    !change.team.paused &&
    (change.purposeChanged ||
      change.events.some(
        (event) =>
          event.type === "message" &&
          isTeamSystemMessage(event.message) &&
          event.message.content.type === "team_paused" &&
          !event.message.content.paused,
      ))
  ) {
    await wakeTeamAgent(change.team.id, {
      type: "team_message",
      senderName: "the user",
    });
  }
  return change.team;
}

export async function deleteTeam(teamId: string): Promise<boolean> {
  const database = new TeamDatabase(await getStateDatabase());
  const agentIds = await database.deleteTeam(teamId);
  if (!agentIds) return false;
  teamEditQueues.delete(teamId);
  releaseTeamEvents(teamId);
  deleteSavedDraft(`team:${teamId}`);
  broadcast({ type: "team.deleted", teamId });
  const cleanup = await Promise.allSettled(agentIds.map((id) => deleteWorker(id)));
  const errors = cleanup.flatMap((result, index) =>
    result.status === "rejected"
      ? [new Error(`Unable to delete agent ${agentIds[index]}`, { cause: result.reason })]
      : [],
  );
  if (errors.length) throw new AggregateError(errors, "Team deleted; agent cleanup failed.");
  return true;
}

export async function removeTeamMember(agentId: string): Promise<void> {
  const member = await new TeamDatabase(await getStateDatabase()).getMember(agentId);
  if (!member) return;
  await deleteWorker(agentId, "team");
}

/**
 * Moves members to an existing team or to a new one that starts with its own lead and purpose,
 * keeping each member's Session. Returns the team they joined.
 */
export async function moveTeamMembers({
  teamId,
  agentIds,
  to,
}: {
  teamId: string;
  agentIds: readonly string[];
  to: { teamId: string } | { newTeam: Pick<CreateTeamInput, "name" | "purpose"> };
}): Promise<Team> {
  const database = new TeamDatabase(await getStateDatabase());
  const source = await database.getTeam(teamId);
  if (!source) throw new Error("Team not found.");
  const target =
    "teamId" in to
      ? await database.getTeam(to.teamId)
      : await createTeam({
          ...to.newTeam,
          model: source.model,
          ...(source.directory ? { directory: source.directory } : {}),
        });
  if (!target) throw new Error("The target team is gone.");
  const change = await database.moveMembers(teamId, agentIds, target.id);
  publishTeamChange(change.source);
  publishTeamChange(change.target);
  return change.target.team;
}

export async function markTeamRead(teamId: string, sequence: number): Promise<Team | null> {
  const database = new TeamDatabase(await getStateDatabase());
  const change = await database.markUserSeen(teamId, sequence);
  if (change) publishTeamChange(change);
  return change?.team ?? database.getTeam(teamId);
}

export async function postTeamMessage(input: PostTeamMessageInput): Promise<TeamMessage> {
  return resolveMessageResources(await postMessage({ ...input, sender: { type: "user" } }));
}

export async function postTeamMessageFromSession(
  sessionId: string,
  input: Omit<PostTeamMessageInput, "attachments"> & {
    attachmentPaths?: readonly string[];
  },
): Promise<StoredTeamMessage> {
  const { attachmentPaths, ...message } = input;
  return postMessage({
    ...message,
    sender: { type: "user" },
    attachments: await resolveAttachmentPaths(sessionId, attachmentPaths),
  });
}

export async function readTeamForSession(teamId: string, beforeSequence?: number) {
  const database = new TeamDatabase(await getStateDatabase());
  const team = await database.getTeam(teamId);
  if (!team) throw new Error("Team not found.");
  const messages = await database.listMessagesBefore(team.id, beforeSequence, TEAM_MESSAGE_LIMIT);
  return readTeam(database, team, messages, (messages[0]?.sequence ?? 1) > 1);
}

export async function waitForTeamAgents(
  teamId: string,
  agentIds: readonly string[],
  timeoutMs?: number,
) {
  const agentIdsInTeam = new Set(
    await new TeamDatabase(await getStateDatabase()).listAgentIds(teamId),
  );
  if (agentIds.some((agentId) => !agentIdsInTeam.has(agentId))) {
    throw new Error("One or more agent IDs do not belong to this team.");
  }
  const completions = await waitForSessions(agentIds, timeoutMs);
  return completions.map(({ status }, index) => ({ agentId: agentIds[index]!, status }));
}

export async function readTeamForAgent(sessionId: string) {
  const database = new TeamDatabase(await getStateDatabase());
  const agent = await requireTeamAgent(database, sessionId);
  const team = await database.getTeam(agent.teamId);
  if (!team) throw new Error("Team not found.");
  const messages = await database.listMessagesAfter(team.id, agent.seenThrough, TEAM_MESSAGE_LIMIT);
  const readThrough = messages.at(-1)?.sequence ?? agent.seenThrough;
  const result = await readTeam(database, team, messages, readThrough < team.latestSequence);
  await database.markAgentSeen(agent.id, readThrough);
  return result;
}

export async function getTeamThreadSequence(teamId: string, sequence: number) {
  const database = new TeamDatabase(await getStateDatabase());
  if (!(await database.getTeam(teamId))) throw new Error("Team not found.");
  return database.getThreadSequence(teamId, sequence);
}

export async function searchTeamMessages(teamId: string, query: string, threadSequence?: number) {
  return new TeamDatabase(await getStateDatabase()).searchMessages(teamId, query, threadSequence);
}

/** One thread in full, read without changing anyone's read position. */
export async function readTeamThread(teamId: string, threadSequence: number) {
  const database = new TeamDatabase(await getStateDatabase());
  const team = await database.getTeam(teamId);
  if (!team) throw new Error("Team not found.");
  return readTeam(database, team, await database.listThread(team.id, threadSequence), false);
}

export async function readTeamThreadForAgent(sessionId: string, threadSequence: number) {
  const agent = await requireTeamAgent(new TeamDatabase(await getStateDatabase()), sessionId);
  return readTeamThread(agent.teamId, threadSequence);
}

async function readTeam(
  database: TeamDatabase,
  team: Team,
  messages: StoredTeamMessage[],
  hasMore: boolean,
) {
  const [roster, artifacts, routines] = await Promise.all([
    database.getRoster(team.id),
    database.listArtifacts(team.id),
    database.listRoutines(team.id),
  ]);
  if (!roster) throw new Error("Team not found.");
  const { lead, members } = roster;
  return {
    team,
    lead,
    members,
    messages,
    artifacts,
    routines,
    hasMore,
  };
}

export async function sendTeamMessageFromAgent(
  sessionId: string,
  input: {
    content: string;
    attachmentPaths?: readonly string[];
    request?: boolean;
    threadSequence?: number;
  },
): Promise<StoredTeamMessage> {
  const database = new TeamDatabase(await getStateDatabase());
  const agent = await requireTeamAgent(database, sessionId);
  const { teamsAddressedFrom, admitAgentTeamMessage } = await import("./peers");
  const roster = await database.getRoster(agent.teamId);
  admitAgentTeamMessage(
    agent,
    await teamsAddressedFrom(
      agent.teamId,
      input.content,
      roster ? [roster.lead, ...roster.members] : [],
    ),
  );
  return postMessage({
    id: crypto.randomUUID(),
    teamId: agent.teamId,
    sender: {
      type: "agent",
      agentId: agent.id,
    },
    content: input.content,
    attachments: await resolveAttachmentPaths(sessionId, input.attachmentPaths),
    request: input.request,
    threadSequence: input.threadSequence,
  });
}

export async function setTeamMessageReactionFromAgent(
  sessionId: string,
  input: { sequence: number; reaction: TeamReaction["reaction"] | null },
): Promise<TeamReaction["reaction"] | null> {
  const database = new TeamDatabase(await getStateDatabase());
  const agent = await requireTeamAgent(database, sessionId);
  const change = await database.setMessageReaction({
    teamId: agent.teamId,
    sequence: input.sequence,
    agentId: agent.id,
    reaction: input.reaction,
  });
  if (!change) return null;
  const reaction = change.reaction?.reaction ?? null;
  publishTeamChange(change);
  return reaction;
}

export async function setTeamAgentStatus(
  sessionId: string,
  input: SetTeamAgentStatusInput,
): Promise<TeamAgentStatus> {
  const database = new TeamDatabase(await getStateDatabase());
  const status: TeamAgentStatus = {
    state: "working",
    text: input.status,
    ...(input.lookingAt ? { lookingAt: input.lookingAt } : {}),
    ...(input.workingOn ? { workingOn: input.workingOn } : {}),
  };
  const change = await database.setAgentStatus(sessionId, status);
  if (change) publishTeamChange(change);
  return status;
}

/** Ends a turn. A lead waiting on a member or external work can ask to wake after a delay. */
export async function finishTeamAgentTurn(
  sessionId: string,
  waitingFor?: string,
  wakeAfterMinutes?: number,
): Promise<void> {
  const database = new TeamDatabase(await getStateDatabase());
  const wakeAt = wakeAfterMinutes
    ? new Date(Date.now() + wakeAfterMinutes * 60_000).toISOString()
    : undefined;
  const change = await database.setAgentStatus(
    sessionId,
    waitingFor ? { state: "waiting", text: waitingFor, ...(wakeAt ? { wakeAt } : {}) } : undefined,
    false,
  );
  if (change) publishTeamChange(change);
}

export async function setTeamRoutineFromLead(
  sessionId: string,
  input: SetTeamRoutineInput,
): Promise<TeamRoutine> {
  const change = await new TeamDatabase(await getStateDatabase()).setRoutine(sessionId, input);
  publishTeamChange(change);
  return change.routine;
}

/** Returns false when the routine was already gone. */
export async function deleteTeamRoutine(teamId: string, routineId: string): Promise<boolean> {
  const change = await new TeamDatabase(await getStateDatabase()).deleteRoutine(teamId, routineId);
  if (!change) return false;
  publishTeamChange(change);
  return true;
}

/** Privately wake each agent whose follow-up or routine is due. Claims commit before delivery. */
export async function wakeDueTeamAgents(now = new Date()): Promise<void> {
  try {
    const database = await getStateDatabase({ createIfMissing: false });
    if (!database) return;
    const { followUps, routines } = await new TeamDatabase(database).claimDueWakes(now);
    for (const { change } of followUps) publishTeamChange(change);
    await Promise.all([
      ...followUps.map(({ agentId, waitingFor }) =>
        wakeAgent(agentId, { type: "team_follow_up", waitingFor }),
      ),
      ...routines.map(({ agentId, title, prompt }) =>
        wakeAgent(agentId, { type: "team_routine", title, prompt }),
      ),
    ]);
  } catch (error) {
    console.error("Failed to wake due Team agents:", error);
  }
}

/** Runs a routine now without changing its schedule. Returns false when it's already gone. */
export async function runTeamRoutine(teamId: string, routineId: string): Promise<boolean> {
  const database = new TeamDatabase(await getStateDatabase());
  const team = await database.getTeam(teamId);
  if (!team) throw new Error("Team not found.");
  if (team.paused) throw new Error("Resume the team before running a routine.");
  const routines = await database.listRoutines(teamId);
  const routine = routines.find(({ id }) => id === routineId);
  if (!routine) return false;
  await wakeTeamAgent(routine.agentId ?? teamId, {
    type: "team_routine",
    title: routine.title,
    prompt: routine.prompt,
  });
  return true;
}

function wakeAgent(agentId: string, systemMessage: SessionSystemMessage): Promise<void> {
  return wakeTeamAgent(agentId, systemMessage).catch((error) => {
    console.error(`Failed to wake Team agent ${agentId}:`, error);
  });
}

/** What agents can attach: media to look at, and documents to read or pass on. */
const TEAM_ATTACHMENT_TYPE = /^(image\/|video\/|text\/(markdown|plain)\b|application\/pdf\b)/;

async function resolveAttachmentPaths(sessionId: string, paths: readonly string[] | undefined) {
  if (!paths?.length) return undefined;
  const directory = paths.some((path) => !isAbsolute(path))
    ? await getSessionDirectory(sessionId)
    : undefined;
  return Promise.all(
    paths.map(async (path) => {
      if (!isAbsolute(path) && !directory)
        throw new Error("Use an absolute attachment path when this Session has no workspace.");
      const absolutePath = resolve(directory ?? "", path);
      const file = Bun.file(absolutePath);
      if (!(await file.exists()) || !TEAM_ATTACHMENT_TYPE.test(file.type)) {
        throw new Error(
          `Team attachment is not an image, video, Markdown, text, or PDF file: ${path}`,
        );
      }
      return absolutePath;
    }),
  );
}

/** Persist once, then apply the same audience plan for user, Agent, connector, and team senders. */
export async function postMessage(
  input: Parameters<TeamDatabase["appendMessage"]>[0],
  { authorName }: { authorName?: string } = {},
): Promise<StoredTeamMessage> {
  const { teamId, sender, content, askedBy } = input;
  const database = new TeamDatabase(await getStateDatabase());
  const members = await database.listMembers(teamId);
  const change = await database.appendMessage(input);
  const lead = teamLead(change.team.id);
  publishTeamChange(change);
  const senderName =
    sender.type === "agent"
      ? ([lead, ...members].find(({ id }) => id === sender.agentId)?.name ?? "an agent")
      : sender.type === "connector"
        ? (authorName ?? "a connector")
        : sender.type === "team"
          ? (authorName ?? "another team")
          : "the user";
  // Messages from outside never forward again, so connectors and teams can't relay a loop.
  if (sender.type !== "connector" && sender.type !== "team") {
    const { forwardToAddressedConnectors } = await import("./connectors");
    const { forwardToAddressedTeams } = await import("./peers");
    await Promise.all([
      forwardToAddressedConnectors(change.team, change.message, senderName).catch((error) => {
        console.error(`Failed to forward Team ${teamId} message to connectors:`, error);
      }),
      forwardToAddressedTeams(change.team, change.message, [lead, ...members]).catch((error) => {
        console.error(`Failed to forward Team ${teamId} message to other teams:`, error);
      }),
    ]);
  }
  if (change.team.paused) return change.message;
  const audience = resolveTeamAudience({
    content,
    sender,
    lead,
    members,
    askedBy,
    acknowledgedRequest: change.acknowledgedRequest,
  });

  const author = messageAuthorId(sender) ?? USER_AUTHOR;
  await Promise.all(
    audience.map((member) =>
      wakeTeamAgent(
        member.id,
        { type: "team_message", senderName },
        { author, sequence: change.message.sequence },
      ).catch((error) => {
        console.error(`Failed to wake Team Agent ${member.id}:`, error);
      }),
    ),
  );
  return change.message;
}

export async function shareTeamArtifactFromAgent(
  sessionId: string,
  input: { path: string; title: string },
) {
  const database = new TeamDatabase(await getStateDatabase());
  const agent = await requireTeamAgent(database, sessionId);
  return shareTeamArtifact(database, sessionId, agent.teamId, {
    ...input,
    actor: { type: "agent", agentId: agent.id },
  });
}

export async function shareTeamArtifactFromSession(
  sessionId: string,
  { teamId, ...input }: { teamId: string; path: string; title: string },
) {
  const database = new TeamDatabase(await getStateDatabase());
  return shareTeamArtifact(database, sessionId, teamId, {
    ...input,
    actor: { type: "user" },
  });
}

/** Relative paths resolve against the sharing Session's workspace, then the Team's directory. */
async function shareTeamArtifact(
  database: TeamDatabase,
  sessionId: string,
  teamId: string,
  input: {
    path: string;
    title: string;
    actor: TeamMessageActor;
  },
) {
  const team = await database.getTeam(teamId);
  if (!team) throw new Error("Team not found.");
  const workspaceDirectory = (await getSessionDirectory(sessionId)) ?? team.directory;
  const path = input.path.trim();
  const absolutePath = isAbsolute(path)
    ? resolve(path)
    : workspaceDirectory
      ? resolve(workspaceDirectory, path)
      : undefined;
  if (!absolutePath || !(await Bun.file(absolutePath).exists())) {
    throw new Error("Share an existing file using an absolute or workspace-relative path.");
  }
  const result = await database.shareArtifact({
    teamId,
    file: workspaceFileFromAbsolutePath(absolutePath),
    title: input.title,
    actor: input.actor,
  });
  publishTeamChange(result);
  return result.artifact;
}

export async function detachTeamAgentSession(sessionId: string): Promise<void> {
  const database = new TeamDatabase(await getStateDatabase());
  const change = await database.deleteMember(sessionId);
  if (!change) return;
  publishTeamChange(change);
}

async function requireTeamAgent(database: TeamDatabase, sessionId: string) {
  const agent = await database.getAgent(sessionId);
  if (!agent) throw new Error("This agent session does not belong to a team.");
  return agent;
}

/** Publish the committed detail events and their catalog projections together. */
export function publishTeamChange({ teamId, events, team }: TeamChange): void {
  if (events.length === 0) return;
  for (const stored of events) {
    const event = resolveEventResources(stored);
    publishTeamEvent(teamId, event);
    if (event.type === "member") {
      broadcast({ type: "team.member.upserted", member: teamMemberIdentity(event.member) });
    } else if (event.type === "message" && isTeamSystemMessage(event.message)) {
      const content = event.message.content;
      if (content.type === "member_joined")
        broadcast({
          type: "team.member.upserted",
          member: teamMemberIdentity(content.member),
        });
      else if (content.type === "member_left")
        broadcast({ type: "team.member.deleted", teamId, agentId: content.member.id });
    }
  }
  if (team) broadcast({ type: "team.upserted", team });
}

/**
 * Delivers a wake into the agent's turn at once, then records how it landed, so the team can see
 * how often new input reaches its agents mid-turn. `cause` names the message that woke it, when one did.
 */
async function wakeTeamAgent(
  agentId: string,
  systemMessage: SessionSystemMessage,
  cause?: { author: string; sequence: number },
): Promise<void> {
  const database = new TeamDatabase(await getStateDatabase());
  const agent = await requireTeamAgent(database, agentId);
  const team = await database.getTeam(agent.teamId);
  if (!team) throw new Error("Team not found.");
  if (team.paused) return;
  const at = new Date().toISOString();
  const { disposition } = await deliverSessionMessage(agentId, { systemMessage, immediate: true });
  await database
    .recordWake(team.id, {
      agentId,
      at,
      cause:
        systemMessage.type === "team_routine"
          ? "routine"
          : systemMessage.type === "team_follow_up"
            ? "follow_up"
            : "message",
      ...(cause ? { author: cause.author, messageSequence: cause.sequence } : {}),
      delivery: disposition,
    })
    .catch((error) => console.error(`Could not record waking ${agentId}:`, error));
  const change = await database.clearAgentStatus(agentId, "waiting");
  if (change) publishTeamChange(change);
}
