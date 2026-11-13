import { z } from "zod";
import { workspaceFileSchema } from "@files/model";
import { modelConfigurationSchema, type ModelConfiguration } from "@providers/model";
import {
  attachmentsSchema,
  type Attachment,
  type AttachmentReference,
} from "@/shared/attachments/model";
import { cronSchema } from "@/shared/cron";
import { previewSchema, type Preview } from "@/shared/preview";
import type { ConnectorOrigin } from "@connectors/model";
import type { TeamAdvice } from "./advice";
import type { TeamAgentPresence } from "./presence";
import { hasChanges } from "./changes";
import { teamTasksSchema, type TeamTask } from "./tasks";
import {
  agentAvatarSchema,
  agentHandleFromName,
  agentNameSchema,
  agentRoleSchema,
  TEAM_LEAD_PROFILE,
  extractAgentMentionHandles,
  leadingMentionHandles,
} from "./agent";

export * from "./agent";
export * from "./tasks";

const durableIdSchema = z.string().trim().min(1).max(255);
const teamNameSchema = z.string().trim().min(1).max(100);
const teamPurposeSchema = z.string().trim().min(1).max(12_000);
const teamDirectorySchema = z.string().trim().min(1).max(4_096);
const teamMessageTextSchema = z.string().trim().max(12_000);
export const teamMessageContentSchema = teamMessageTextSchema.min(1);
export const teamReactionKindSchema = z.enum(["done", "agree", "celebrate", "love", "laugh"]);

const teamReactionSchema = z
  .object({
    agentId: durableIdSchema,
    reaction: teamReactionKindSchema,
  })
  .strict();

export type Team = {
  id: string;
  name: string;
  paused: boolean;
  purpose?: string;
  directory?: string;
  model: ModelConfiguration;
  tasks: TeamTask[];
  preview?: Preview;
  canvasArtifactId?: string;
  latestSequence: number;
  seenThrough: number;
  /** Transcript-derived: reading acknowledges completed tasks; user replies acknowledge requests. */
  completedSequence: number | null;
  requestSequence: number | null;
  updatedAt: string;
};

/** Attention refers to transcript milestones; reading never answers a request. */
export function teamHasUnreadCompletion(team: Team): boolean {
  return (team.completedSequence ?? 0) > team.seenThrough;
}

export function teamHasPendingRequest(team: Team): boolean {
  return team.requestSequence !== null;
}

export function teamStatus(team: Team): "waiting" | "finished" | "unread" | null {
  if (teamHasPendingRequest(team)) return "waiting";
  if (teamHasUnreadCompletion(team)) return "finished";
  if (teamHasUnread(team)) return "unread";
  return null;
}

export type TeamList = {
  teams: Team[];
  members: Pick<TeamMember, "id" | "teamId" | "name" | "avatar">[];
};

/** The catalog identifies teammates; their live details belong to the open Team. */
export function teamMemberIdentity({
  id,
  teamId,
  name,
  avatar,
}: TeamMember): TeamList["members"][number] {
  return { id, teamId, name, ...(avatar ? { avatar } : {}) };
}

const teamStatusTextSchema = z.string().trim().min(1).max(100);

const teamStatusTargetSchema = z
  .object({
    lookingAt: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The message sequence requesting review of a referenced resource."),
    workingOn: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("The message sequence requesting other substantive work."),
  })
  .strict()
  .refine(({ lookingAt, workingOn }) => lookingAt === undefined || workingOn === undefined, {
    message: "Choose either lookingAt or workingOn.",
  });

export const teamAgentStatusSchema = z.discriminatedUnion("state", [
  teamStatusTargetSchema.safeExtend({
    state: z.literal("working"),
    text: teamStatusTextSchema,
  }),
  z
    .object({
      state: z.literal("waiting"),
      text: teamStatusTextSchema,
      /** A lead follow-up: when to wake if nothing else wakes it first. */
      wakeAt: z.iso.datetime().optional(),
    })
    .strict(),
]);
export type TeamAgentStatus = z.output<typeof teamAgentStatusSchema>;

/** Team-owned configuration and collaboration state stored on its Worker. */
export const teamAgentMetadataSchema = z
  .object({
    role: agentRoleSchema.optional(),
    model: modelConfigurationSchema.optional(),
    avatar: agentAvatarSchema.optional(),
    seenThrough: z.number().int().nonnegative(),
    status: teamAgentStatusSchema.optional(),
  })
  .strict();

export const setTeamAgentStatusInputSchema = teamStatusTargetSchema.safeExtend({
  status: teamStatusTextSchema.describe("A very brief description of the work being performed."),
});
export type SetTeamAgentStatusInput = z.output<typeof setTeamAgentStatusInputSchema>;

const teamMemberSchema = teamAgentMetadataSchema
  .omit({ seenThrough: true })
  .extend({
    teamId: durableIdSchema,
    id: durableIdSchema,
    name: agentNameSchema,
  })
  .strict();
export type TeamMember = z.output<typeof teamMemberSchema>;

export type TeamAgent = Pick<TeamMember, "id" | "name" | "role" | "avatar" | "status">;
export type TeamLead = TeamAgent & {
  role: string;
  avatar: NonNullable<TeamAgent["avatar"]>;
};

export function compareTeamAgents(
  left: Pick<TeamAgent, "name" | "id">,
  right: Pick<TeamAgent, "name" | "id">,
): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

export function teamLead(id: string, status?: TeamAgentStatus): TeamLead {
  return {
    id,
    ...TEAM_LEAD_PROFILE,
    ...(status ? { status } : {}),
  };
}

export type TeamMessageSender = TeamMessageAuthor | { type: "system" };

export type TeamReaction = z.output<typeof teamReactionSchema>;

/** Client attachments carry either uploaded bytes or one resolved file address. */
export type TeamAttachment = Attachment | AttachmentReference;

/** A shared file. Sharing it again only changes its title, never when it was first shared. */
const teamArtifactSchema = z
  .object({
    file: workspaceFileSchema,
    title: z.string().trim().min(1).max(160),
    sharedAt: z.string(),
  })
  .strict();
export type TeamArtifact = z.output<typeof teamArtifactSchema> & {
  /** The shared file's identity, which tasks reference as `artifactId`. */
  id: string;
  /** Public resource address supplied by the server; never accepted as a command input. */
  url?: string;
  /** The user filed it away from the composer tray; it stays shared and openable. */
  archived?: true;
  pinned?: true;
};

const teamArtifactIdSchema = z.string().min(1);

/** How the user arranges shared artifacts. Omitted fields keep their places, pins and archive state. */
export const arrangeTeamArtifactsInputSchema = z
  .object({
    teamId: durableIdSchema,
    /** The artifacts to arrange, in the order a move places them. */
    artifactIds: z
      .array(teamArtifactIdSchema)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length, "List each artifact once."),
    /** The artifact they move before, or null to move them last. */
    beforeArtifactId: teamArtifactIdSchema.nullable().optional(),
    archived: z.boolean().optional(),
    pinned: z.boolean().optional(),
  })
  .strict();
export type ArrangeTeamArtifactsInput = z.output<typeof arrangeTeamArtifactsInputSchema>;

/** Moves or archives some artifacts, leaving the rest of the user's arrangement in place. A move
 *  places them together, in the given order. */
export function applyTeamArtifactArrangement(
  artifacts: readonly TeamArtifact[],
  { artifactIds, beforeArtifactId, archived, pinned }: Omit<ArrangeTeamArtifactsInput, "teamId">,
): TeamArtifact[] {
  const shared = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  if (
    artifactIds.some((id) => !shared.has(id)) ||
    (beforeArtifactId && !shared.has(beforeArtifactId))
  ) {
    throw new Error("Arrange artifacts shared in this team.");
  }
  if (beforeArtifactId && artifactIds.includes(beforeArtifactId)) {
    throw new Error("Move artifacts before one that isn't moving.");
  }
  const arranged = new Map(
    artifactIds.map((id) => [id, withArrangement(shared.get(id)!, archived, pinned)] as const),
  );
  if (beforeArtifactId === undefined) {
    return orderTeamArtifacts(artifacts.map((artifact) => arranged.get(artifact.id) ?? artifact));
  }
  const others = artifacts.filter(({ id }) => !arranged.has(id));
  const index =
    beforeArtifactId === null
      ? others.length
      : others.findIndex(({ id }) => id === beforeArtifactId);
  return orderTeamArtifacts([
    ...others.slice(0, index),
    ...arranged.values(),
    ...others.slice(index),
  ]);
}

export function orderTeamArtifacts(artifacts: readonly TeamArtifact[]): TeamArtifact[] {
  return [
    ...artifacts.filter(({ pinned }) => pinned),
    ...artifacts.filter(({ pinned }) => !pinned),
  ];
}

function withArrangement(
  artifact: TeamArtifact,
  archived: boolean | undefined,
  pinned: boolean | undefined,
): TeamArtifact {
  const isArchived = archived ?? !!artifact.archived;
  if (pinned && isArchived) throw new Error("Restore an artifact before pinning it.");
  const isPinned = !isArchived && (pinned ?? !!artifact.pinned);
  if (isArchived === !!artifact.archived && isPinned === !!artifact.pinned) return artifact;
  const { archived: _archived, pinned: _pinned, ...rest } = artifact;
  return {
    ...rest,
    ...(isArchived ? { archived: true } : {}),
    ...(isPinned ? { pinned: true } : {}),
  };
}

const teamMessageActorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user") }).strict(),
  z.object({ type: z.literal("agent"), agentId: durableIdSchema }).strict(),
]);

/** Who wrote a conversation message: the user, an agent, a connector relaying its service, or
 *  another team, whose lead or user addressed this team from there. */
export type TeamMessageAuthor =
  | TeamMessageActor
  | { type: "connector"; connectorId: string }
  | { type: "team"; teamId: string; by: "lead" | "user" };

/** The agent, connector, or team that wrote a message; the user has no author ID. */
export function messageAuthorId(sender: TeamMessageAuthor): string | undefined {
  return sender.type === "agent"
    ? sender.agentId
    : sender.type === "connector"
      ? sender.connectorId
      : sender.type === "team"
        ? sender.teamId
        : undefined;
}

export const CONNECTOR_AVATAR = {
  mark: "M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z",
  color: "#7c3aed",
} as const;

/** A connector speaks in a transcript where an agent would, under its own name and mark. */
export function connectorAuthor({ id, name }: { id: string; name: string }): TeamAgent {
  return { id, name, role: "Connector", avatar: CONNECTOR_AVATAR };
}

export const TEAM_AUTHOR_AVATAR = {
  mark: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  color: "#0f766e",
} as const;

/** Another team speaks in a transcript under its own name, like a connector. */
export function teamAuthor({ id, name }: Pick<Team, "id" | "name">): TeamAgent {
  return { id, name, role: "Team", avatar: TEAM_AUTHOR_AVATAR };
}

/** The @handle that reaches a team's lead from another team. */
export function teamHandle(team: Pick<Team, "name">): string {
  return agentHandleFromName(team.name);
}

/**
 * The teams one team can address: every other team whose handle no agent of its own or connector
 * already answers to, since those take precedence.
 */
export function addressableTeams<T extends Pick<Team, "id" | "name">>(
  teams: readonly T[],
  {
    teamId,
    agents,
    connectors,
  }: {
    teamId: string;
    agents: readonly { name: string }[];
    connectors: readonly { name: string }[];
  },
): T[] {
  const taken = new Set([
    "everyone",
    ...[...agents, ...connectors].map(({ name }) => agentHandleFromName(name)),
  ]);
  return teams.filter((team) => team.id !== teamId && !taken.has(teamHandle(team)));
}

/** The teams a message opens by addressing; elsewhere a team's handle is just its name. */
export function teamsAddressedBy<T extends Pick<Team, "name">>(
  content: string,
  teams: readonly T[],
): T[] {
  const handles = leadingMentionHandles(content);
  return teams.filter((team) => handles.includes(teamHandle(team)));
}

/** Who and where a connector relayed content from, such as "Bryan Chen (you) in Slack". */
export function connectorOriginLabel(origin: ConnectorOrigin, owner = "you"): string {
  const where = origin.kind === "slack" ? "Slack" : origin.kind;
  const requester = origin.requester;
  if (!requester) return where;
  return `${requester.name ?? requester.id}${requester.isOwner ? ` (${owner})` : ""} in ${where}`;
}

/** A titled, recurring prompt that privately wakes a team agent. Only the lead adds or changes one. */
export const teamRoutineInputSchema = z
  .object({
    title: z.string().trim().min(1).max(80).describe("A short name for the routine."),
    agentId: durableIdSchema
      .optional()
      .describe("The current team agent to wake, by agentId from read_team. Omit for the lead."),
    schedule: cronSchema
      // One fixed minute can match at most once an hour.
      .refine(
        (schedule) => /^\d+(\s+\S+){4}$/.test(schedule),
        "Routines run at most hourly. Use a 5-field cron with one fixed minute, like 0 9 * * 1-5.",
      )
      .describe("A 5-field cron in local time with one fixed minute, like 0 9 * * 1-5."),
    prompt: z
      .string()
      .trim()
      .min(1)
      .max(2_000, "Routine prompts must be at most 2,000 characters.")
      .describe("What to check or do each time the routine wakes you, at most 2,000 characters."),
  })
  .strict();

const teamRoutineSchema = teamRoutineInputSchema.extend({ id: durableIdSchema });
export type TeamRoutine = z.output<typeof teamRoutineSchema>;

export const setTeamRoutineInputSchema = teamRoutineInputSchema.extend({
  routineId: durableIdSchema.optional().describe("The routine to change. Omit it to add one."),
});
export type SetTeamRoutineInput = z.output<typeof setTeamRoutineInputSchema>;

export const teamRoutineIdentitySchema = z
  .object({ teamId: durableIdSchema, routineId: durableIdSchema })
  .strict();

export const teamSystemMessageContentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("team_paused"), paused: z.boolean() }).strict(),
  z.object({ type: z.literal("tasks_completed") }).strict(),
  z.object({ type: z.literal("member_joined"), member: teamMemberSchema }).strict(),
  z.object({ type: z.literal("member_left"), member: teamMemberSchema }).strict(),
  z
    .object({
      type: z.literal("connector_undelivered"),
      connectorId: durableIdSchema,
      /** The thread whose message the connector never received. */
      threadSequence: z.number().int().positive().optional(),
      reason: z.enum(["expired", "rejected", "throttled"]),
      excerpt: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("team_renamed"),
      actor: teamMessageActorSchema,
      name: teamNameSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("team_purpose_changed"),
      actor: teamMessageActorSchema,
      purpose: teamPurposeSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("team_directory_changed"),
      actor: teamMessageActorSchema,
      directory: teamDirectorySchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("preview_changed"),
      actor: teamMessageActorSchema,
      preview: previewSchema.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_changed"),
      actor: teamMessageActorSchema,
      canvasArtifactId: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("artifact_shared"),
      actor: teamMessageActorSchema,
      // The message's own timestamp records when it was shared.
      artifact: teamArtifactSchema.omit({ sharedAt: true }),
    })
    .strict(),
  z
    .object({
      type: z.enum(["routine_scheduled", "routine_edited", "routine_deleted"]),
      routine: teamRoutineSchema,
    })
    .strict(),
]);
export type TeamSystemMessageContent = z.output<typeof teamSystemMessageContentSchema>;

type TeamMessageBase = {
  id: string;
  sequence: number;
  timestamp: string;
};

export type TeamConversationMessage<A = TeamAttachment> = TeamMessageBase & {
  sender: TeamMessageAuthor;
  content: string;
  /** Where a connector's forwarded content came from. */
  origin?: ConnectorOrigin;
  /** The agent whose message a connector's reply answers; unaddressed, the reply wakes it. */
  askedBy?: string;
  /** The lead asks for the user's response; a later user message acknowledges it. */
  request?: true;
  /** A reply's thread: the sequence of the top-level message that starts it. */
  threadSequence?: number;
  attachments?: A[];
  reactions?: TeamReaction[];
};

export type TeamSystemMessage = TeamMessageBase & {
  sender: { type: "system" };
  content: TeamSystemMessageContent;
  attachments?: never;
  reactions?: never;
  askedBy?: never;
  request?: never;
  threadSequence?: never;
};

/** Replying to any message in a thread replies to that thread; system messages start none. */
export const teamThreadSequenceSchema = z
  .number()
  .int()
  .positive()
  .describe(
    "Replies in the thread of the user or agent message with this sequence, or of the thread that message belongs to.",
  );

export type TeamMessage<A = TeamAttachment> = TeamConversationMessage<A> | TeamSystemMessage;

export function isTeamSystemMessage(message: TeamMessage<unknown>): message is TeamSystemMessage {
  return message.sender.type === "system";
}

/** Canonical reduced state of one Team; a snapshot is this value at one revision. */
export type TeamState = {
  /** Advances with every durable detail change; messages have their own sequence. */
  revision: number;
  team: Team;
  lead: TeamLead;
  members: TeamMember[];
  messages: TeamMessage[];
  /** The newest unanswered public request, including one outside the message window. */
  request: TeamConversationMessage | null;
  /** In the user's arrangement: pins first, then new shares. */
  artifacts: TeamArtifact[];
  /** Oldest first. */
  routines: TeamRoutine[];
  /** Open advice first, then recently resolved; newest first within each. */
  advice: TeamAdvice[];
  presence: Record<string, TeamAgentPresence>;
};

export type TeamEvent<A = TeamAttachment> = (
  | {
      type: "message";
      message: TeamMessage<A>;
    }
  | {
      type: "reaction";
      sequence: number;
      agentId: string;
      reaction: TeamReaction["reaction"] | null;
    }
  | { type: "tasks"; tasks: TeamTask[] }
  | { type: "artifacts"; artifacts: TeamArtifact[] }
  | { type: "advice"; advice: TeamAdvice }
  | { type: "model"; model: ModelConfiguration; updatedAt: string }
  | { type: "read"; seenThrough: number }
  | { type: "member"; member: TeamMember }
  | { type: "status"; agentId: string; status?: TeamAgent["status"] }
) & { revision: number };

/** Cached clients replay ordered details; only a new client or expired cursor needs a snapshot. */
export type TeamObservationEvent =
  | { type: "snapshot"; state: TeamState }
  | { type: "resumed"; presence: Record<string, TeamAgentPresence> }
  | { type: "presence"; presence: Record<string, TeamAgentPresence> }
  | TeamEvent
  | { type: "deleted"; teamId: string };

export const createTeamInputSchema = z
  .object({
    name: teamNameSchema,
    purpose: teamPurposeSchema
      .optional()
      .describe("What the team is for. Omit it to let the lead ask the user."),
    directory: teamDirectorySchema.optional(),
    model: modelConfigurationSchema,
  })
  .strict();

export const teamIdentitySchema = z.object({ teamId: durableIdSchema }).strict();

export const removeTeamMemberInputSchema = z.object({ agentId: durableIdSchema }).strict();

const teamChangesSchema = z
  .object({
    model: modelConfigurationSchema.optional(),
    name: teamNameSchema.optional().describe("The team's new title."),
    purpose: teamPurposeSchema
      .nullable()
      .optional()
      .describe("What the team is currently for, or null to clear it."),
    directory: teamDirectorySchema
      .nullable()
      .optional()
      .describe(
        "The working directory for all team agents on their next execution, or null to clear it.",
      ),
    tasks: teamTasksSchema
      .optional()
      .describe(
        "The complete task list for initial planning or intentional replacement. Preserve retained task IDs and outcomes; use edit_team_tasks for progress updates.",
      ),
    preview: previewSchema
      .nullable()
      .optional()
      .describe(
        "The current runnable preview: a URL or an existing screenId, or null to clear it.",
      ),
    canvasArtifactId: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        "The artifactId of a shared session-owned .toy app to present beside team chat, or null to clear it. Create, validate, and share the app first.",
      ),
  })
  .strict();
export type TeamChanges = z.output<typeof teamChangesSchema>;
export type TeamMessageActor = z.output<typeof teamMessageActorSchema>;

export const editTeamInputSchema = teamChangesSchema
  .pick({ name: true, purpose: true, model: true })
  .extend({ ...teamIdentitySchema.shape, paused: z.boolean().optional() })
  .refine(({ teamId: _teamId, ...changes }) => hasChanges(changes), {
    message: "Change the team name, purpose, lead model, or paused state.",
  });

export const updateTeamInputSchema = teamChangesSchema.omit({ model: true }).refine(hasChanges, {
  message:
    "Update the name, purpose, directory, tasks, preview, canvas, or any combination of them.",
});

export const postTeamMessageInputSchema = z
  .object({
    id: durableIdSchema,
    teamId: durableIdSchema,
    content: teamMessageTextSchema,
    attachments: attachmentsSchema.optional(),
    threadSequence: teamThreadSequenceSchema.optional(),
  })
  .strict()
  .refine(({ content, attachments }) => content.length > 0 || (attachments?.length ?? 0) > 0, {
    message: "A message or attachment is required",
  });

export const markTeamReadInputSchema = z
  .object({
    teamId: durableIdSchema,
    sequence: z.number().int().nonnegative(),
  })
  .strict();

export type CreateTeamInput = z.output<typeof createTeamInputSchema>;
export type EditTeamInput = z.output<typeof editTeamInputSchema>;
export type PostTeamMessageInput = z.output<typeof postTeamMessageInputSchema>;
export type UpdateTeamInput = z.output<typeof updateTeamInputSchema>;

type TeamReadPosition = Pick<Team, "latestSequence" | "seenThrough">;

export function teamHasUnread(team: TeamReadPosition): boolean {
  return team.latestSequence > team.seenThrough;
}

/** The read position that unread messages follow, or null when everything has been read. */
export function teamUnreadAfter(team: TeamReadPosition): number | null {
  return teamHasUnread(team) ? team.seenThrough : null;
}

/** Complete delivery policy for user, lead, member, and connector messages. */
export function resolveTeamAudience({
  content,
  sender,
  lead,
  members,
  askedBy,
  acknowledgedRequest = false,
}: {
  content: string;
  sender: TeamMessageAuthor;
  lead: TeamAgent;
  members: readonly TeamAgent[];
  /** For a connector's reply, the agent whose message it answers. */
  askedBy?: string;
  /** Persistence established that this user reply acknowledged a pending request. */
  acknowledgedRequest?: boolean;
}): TeamAgent[] {
  // Another team reaches only this team's lead, which decides what its members do.
  if (sender.type === "team") return [lead];
  const { handles, mentionAll } = extractAgentMentionHandles(content);
  const agents = [lead, ...members];
  const agentHandles = new Set(agents.map(({ name }) => agentHandleFromName(name)));
  const leading = new Set(leadingMentionHandles(content));
  // An agent's handle addresses it anywhere. Any other handle, such as a connector's, addresses
  // only where the message opens; elsewhere it's just a name in the text.
  const addressed = handles.filter((handle) => agentHandles.has(handle) || leading.has(handle));
  const mentionedIds = new Set(
    agents.filter(({ name }) => addressed.includes(agentHandleFromName(name))).map(({ id }) => id),
  );
  const senderId = sender.type === "agent" ? sender.agentId : undefined;
  if (!mentionAll && addressed.length === 0) {
    // A reply answers whoever asked, while it's still on the team.
    const asker = agents.find(({ id }) => id === askedBy);
    if (asker) return [asker];
    return lead.id === senderId ? [] : [lead];
  }
  return agents.filter(
    ({ id }) =>
      id !== senderId &&
      (mentionAll || mentionedIds.has(id) || (acknowledgedRequest && id === lead.id)),
  );
}

/** An audience by name, or "Everyone" when it's every agent the sender could reach. */
export function teamAudienceLabel(audience: readonly TeamAgent[], reachableCount: number): string {
  return audience.length > 1 && audience.length === reachableCount
    ? "Everyone"
    : audience.map(({ name }) => name).join(", ");
}
