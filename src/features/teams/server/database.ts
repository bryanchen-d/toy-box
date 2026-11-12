import {
  agentHandleFromName,
  teamAgentMetadataSchema,
  isTeamSystemMessage,
  teamTasksSchema,
  applyTeamTaskEdits,
  applyTeamArtifactArrangement,
  teamTasksComplete,
  teamSystemMessageContentSchema,
  TEAM_LEAD_PROFILE,
  unassignTeamTasks,
  type Team,
  type TeamEvent as ClientTeamEvent,
  type TeamChanges,
  type TeamMessageActor,
  type TeamMemberChanges,
  type TeamAgentStatus,
  type ArrangeTeamArtifactsInput,
  type TeamArtifact,
  type TeamList,
  teamMemberIdentity,
  type TeamMember,
  type TeamMessage as ClientTeamMessage,
  type TeamConversationMessage as ClientConversationMessage,
  type TeamReaction,
  type TeamMessageAuthor,
  type TeamMessageSender,
  type TeamSystemMessageContent,
  type TeamTask,
  type TeamRoutine,
  type CreateTeamInput,
  type EditTeamInput,
  type EditTeamTasksInput,
  type SetTeamRoutineInput,
  type UpdateTeamInput,
} from "@teams/model";
import { reduceTeam } from "@teams/model/reducer";
import { applyPatch } from "@teams/model/changes";
import { previewSchema } from "@/shared/preview";
import { connectorOriginSchema } from "@connectors/model";
import { artifactAppPathSchema } from "@apps/model";
import { machineFile, sessionFile, workspaceFileId } from "@files/model";
import { modelConfigurationSchema } from "@providers/model";
import { inStateTransaction } from "@/server/database";
import { nextCronOccurrence } from "@/shared/cron";
import type { Worker } from "@workers/model";
import { WorkerDatabase } from "@workers/server/database";
import {
  teamAgentFromWorker,
  teamMemberFromWorker,
  teamMembersFromWorkers,
  teamRoster,
  isTeamLead,
} from "@teams/model/worker";

import { z } from "zod";
import { attachmentSchema } from "@/shared/attachments/model";
import { createMessageSearchMatcher, MESSAGE_SEARCH_LIMIT } from "@/shared/messages/search";
import type { TeamMessageMatch } from "@teams/model/search";

const teamAttachmentSchema = z.union([attachmentSchema, z.string().min(1).max(4_096)]);
export type StoredAttachment = z.output<typeof teamAttachmentSchema>;
export type StoredTeamMessage = ClientTeamMessage<StoredAttachment>;
type TeamMessage = StoredTeamMessage;
type TeamConversationMessage = ClientConversationMessage<StoredAttachment>;
type TeamEvent = ClientTeamEvent<StoredAttachment>;

/** A committed public change; catalog metadata is present only when it changed. */
export type TeamChange = {
  teamId: string;
  events: readonly TeamEvent[];
  team?: Team;
};

/** Durable Teams, ordered messages, agent read positions, and shared file references. */
export class TeamDatabase {
  constructor(private readonly db: Bun.SQL) {}

  async listTeams(): Promise<TeamList> {
    const [rows, workers] = await Promise.all([
      readTeamRows(this.db),
      new WorkerDatabase(this.db).list("team"),
    ]);
    const teamIds = new Set(rows.map(({ id }) => id));
    return {
      teams: rows.map(teamFromRow),
      members: workers.flatMap((worker) =>
        !teamIds.has(worker.teamId) || isTeamLead(worker)
          ? []
          : [teamMemberIdentity(teamMemberFromWorker(worker))],
      ),
    };
  }

  async createTeam(input: CreateTeamInput, lead: Extract<Worker, { type: "team" }>): Promise<Team> {
    const id = lead.sessionId;
    return inStateTransaction(this.db, async (db) => {
      await db`
        INSERT INTO teams ${db({
          id,
          ...teamColumns({ ...input, paused: false, tasks: [] }),
          updated_at: lead.createdAt,
        })}
      `;
      await new WorkerDatabase(db).create(lead);
      return requireTeam(db, id);
    });
  }

  async getTeam(teamId: string): Promise<Team | null> {
    const [row] = await readTeamRows(this.db, teamId);
    return row ? teamFromRow(row) : null;
  }

  async editTeam({ teamId, ...changes }: EditTeamInput) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, teamId);
      return updateTeamFields(db, team, changes, { type: "user" });
    });
  }

  async deleteTeam(teamId: string): Promise<string[] | null> {
    return inStateTransaction(this.db, async (db) => {
      const workerDatabase = new WorkerDatabase(db);
      const workers = await workerDatabase.list({ type: "team", teamId });
      for (const worker of workers) await workerDatabase.delete(worker.sessionId);
      const rows = await db<{ id: string }[]>`
        DELETE FROM teams WHERE id = ${teamId} RETURNING id
      `;
      return rows.length ? workers.map(({ sessionId }) => sessionId) : null;
    });
  }

  async markUserSeen(teamId: string, sequence: number) {
    return inStateTransaction(this.db, async (db) => {
      const [row] = await db<TeamRow[]>`
        UPDATE teams
        SET seen_through = MIN(latest_sequence, MAX(seen_through, ${sequence})),
          revision = revision + 1
        WHERE id = ${teamId} AND seen_through < MIN(latest_sequence, ${sequence})
        RETURNING *
      `;
      if (!row) return null;
      const team = teamFromRow(row);
      return {
        teamId,
        team,
        events: [
          {
            type: "read" as const,
            revision: row.revision,
            seenThrough: team.seenThrough,
          },
        ],
      };
    });
  }

  /** The transcript, human cursor, and pending request describe the same durable instant. */
  async getSnapshot(teamId: string, messageLimit: number) {
    return inStateTransaction(this.db, async (db) => {
      const [row] = await readTeamRows(db, teamId);
      if (!row) return null;
      const team = teamFromRow(row);
      return {
        team,
        request:
          team.requestSequence === null
            ? null
            : await readRequest(db, teamId, team.requestSequence),
        revision: row.revision,
        ...teamRoster(await new WorkerDatabase(db).list({ type: "team", teamId })),
        messages: await listMessagesBefore(db, teamId, undefined, messageLimit),
        artifacts: await listArtifacts(db, teamId),
        routines: await listRoutines(db, teamId),
      };
    });
  }

  /** An atomic replay position and presence inputs, without reading public history. */
  async getRoster(teamId: string) {
    return inStateTransaction(this.db, async (db) => {
      const [team] = await db<{ revision: number }[]>`
        SELECT revision FROM teams WHERE id = ${teamId}
      `;
      if (!team) return null;
      return {
        revision: team.revision,
        ...teamRoster(await new WorkerDatabase(db).list({ type: "team", teamId })),
      };
    });
  }

  async listMembers(teamId: string): Promise<TeamMember[]> {
    return teamMembersFromWorkers(await new WorkerDatabase(this.db).list({ type: "team", teamId }));
  }

  async getMember(agentId: string) {
    const agent = await getAgent(this.db, agentId);
    return agent?.isLead ? null : agent;
  }

  async getAgent(agentId: string) {
    return getAgent(this.db, agentId);
  }

  async createMember(worker: Extract<Worker, { type: "team" }>) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, worker.teamId);
      if (team.paused) throw new Error("Resume the team before adding an agent.");
      await assertMemberNameAvailable(db, worker.teamId, worker.name);
      await new WorkerDatabase(db).create(worker);
      const member = teamMemberFromWorker(worker);
      const change = await appendSystemMessage(db, worker.teamId, {
        type: "member_joined",
        member,
      });
      return { ...(await recordTeamChange(db, team, [change])), member };
    });
  }

  async updateMember(agentId: string, changes: TeamMemberChanges) {
    return inStateTransaction(this.db, async (db) => {
      const worker = await requireTeamMemberWorker(db, agentId);
      const { name = worker.name, ...profile } = changes;
      const current = teamAgentMetadataSchema.parse(worker.metadata);
      const metadata = applyPatch(current, profile);
      const member = teamMemberFromWorker({ ...worker, name }, metadata);
      if (name === worker.name && Bun.deepEquals(metadata, current)) {
        return { teamId: worker.teamId, events: [], member };
      }
      if (name !== worker.name) {
        await assertMemberNameAvailable(db, worker.teamId, name, worker.sessionId);
      }
      await new WorkerDatabase(db).update(worker.sessionId, { name, metadata });
      return {
        member,
        teamId: worker.teamId,
        events: [
          {
            type: "member" as const,
            member,
            revision: await advanceRevision(db, worker.teamId),
          },
        ],
      };
    });
  }

  async markAgentSeen(agentId: string, sequence: number): Promise<void> {
    await inStateTransaction(this.db, async (db) => {
      const worker = await requireTeamWorker(db, agentId);
      const metadata = teamAgentMetadataSchema.parse(worker.metadata);
      if (metadata.seenThrough >= sequence) return;
      await new WorkerDatabase(db).update(worker.sessionId, {
        metadata: { ...metadata, seenThrough: sequence },
      });
    });
  }

  async setAgentStatus(agentId: string, status?: TeamAgentStatus, required = true) {
    return changeAgentStatus(this.db, agentId, status, required);
  }

  async clearAgentStatus(agentId: string, state: TeamAgentStatus["state"]) {
    return changeAgentStatus(this.db, agentId, undefined, false, state);
  }

  async updateTeam(leadId: string, input: UpdateTeamInput) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireLeadTeam(db, leadId);
      if (input.tasks) await assertTaskReferences(db, team.id, input.tasks);
      if (input.canvasArtifactId) {
        const artifact = (await listArtifacts(db, team.id)).find(
          ({ id }) => id === input.canvasArtifactId,
        );
        if (
          !artifact ||
          artifact.file.kind !== "session" ||
          !artifactAppPathSchema.safeParse(artifact.file.path).success
        ) {
          throw new Error("Choose a shared session-owned .toy app as the team canvas.");
        }
      }
      return updateTeamFields(db, team, input, { type: "agent", agentId: leadId });
    });
  }

  async editTasks(leadId: string, { operations }: EditTeamTasksInput) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireLeadTeam(db, leadId);
      const tasks = applyTeamTaskEdits(team.tasks, operations);
      await assertTaskReferences(db, team.id, tasks, team.tasks);
      return updateTeamFields(db, team, { tasks }, { type: "agent", agentId: leadId });
    });
  }

  async deleteMember(agentId: string) {
    return inStateTransaction(this.db, async (db) => {
      const workers = new WorkerDatabase(db);
      const worker = await workers.get(agentId, "team");
      if (!worker || isTeamLead(worker)) return null;
      const member = teamMemberFromWorker(worker);
      if (!(await workers.delete(agentId))) return null;
      const team = await requireTeam(db, member.teamId);
      const { tasks } = team;
      const unassigned = unassignTeamTasks(tasks, agentId);
      if (!Bun.deepEquals(unassigned, tasks)) {
        await db`
          UPDATE teams SET tasks = ${JSON.stringify(unassigned)} WHERE id = ${member.teamId}
        `;
      }
      const change = await appendSystemMessage(db, member.teamId, {
        type: "member_left",
        member,
      });
      return { ...(await recordTeamChange(db, team, [change])), member };
    });
  }

  async listAgentIds(teamId: string): Promise<string[]> {
    return (await new WorkerDatabase(this.db).list({ type: "team", teamId }))
      .map(({ sessionId }) => sessionId)
      .sort();
  }

  async listMessagesAfter(
    teamId: string,
    afterSequence = 0,
    limit?: number,
  ): Promise<TeamMessage[]> {
    const rows = await this.db<TeamMessageRow[]>`
      SELECT * FROM team_messages
      WHERE team_id = ${teamId} AND sequence > ${afterSequence}
      ORDER BY sequence
      LIMIT ${limit ?? -1}
    `;
    return hydrateMessages(this.db, teamId, rows);
  }

  async listMessagesBefore(
    teamId: string,
    beforeSequence?: number,
    limit = 100,
  ): Promise<TeamMessage[]> {
    return listMessagesBefore(this.db, teamId, beforeSequence, limit);
  }

  async getThreadSequence(teamId: string, sequence: number): Promise<number> {
    return resolveThreadSequence(this.db, teamId, sequence);
  }

  /** Search public conversation text without hydrating attachments or changing read positions. */
  async searchMessages(
    teamId: string,
    query: string,
    threadSequence?: number,
  ): Promise<TeamMessageMatch[]> {
    await requireTeam(this.db, teamId);
    const thread =
      threadSequence === undefined ? null : await this.getThreadSequence(teamId, threadSequence);
    const findMatch = createMessageSearchMatcher(query);
    const matches: TeamMessageMatch[] = [];
    let before = Number.MAX_SAFE_INTEGER;
    for (;;) {
      const rows = await this.db<
        Pick<
          TeamMessageRow,
          | "sequence"
          | "sender_type"
          | "sender_agent_id"
          | "sender_connector_id"
          | "content"
          | "thread_sequence"
        >[]
      >`
        SELECT sequence, sender_type, sender_agent_id, sender_connector_id, content, thread_sequence
        FROM team_messages
        WHERE team_id = ${teamId} AND sequence < ${before} AND sender_type <> 'system'
          AND (${thread} IS NULL OR sequence = ${thread} OR thread_sequence = ${thread})
        ORDER BY sequence DESC
        LIMIT 100
      `;
      for (const row of rows) {
        const match = findMatch(row.content);
        if (!match) continue;
        matches.push({
          sequence: row.sequence,
          threadSequence: row.thread_sequence ?? row.sequence,
          sender: authorFromRow(row),
          ...match,
        });
        if (matches.length === MESSAGE_SEARCH_LIMIT) return matches;
      }
      if (rows.length < 100) return matches;
      before = rows.at(-1)!.sequence;
    }
  }

  /** The thread a message starts or belongs to: its top-level message, then every reply. */
  async listThread(teamId: string, sequence: number): Promise<TeamMessage[]> {
    return inStateTransaction(this.db, async (db) => {
      const threadSequence = await resolveThreadSequence(db, teamId, sequence);
      const rows = await db<TeamMessageRow[]>`
        SELECT * FROM team_messages
        WHERE team_id = ${teamId}
          AND (sequence = ${threadSequence} OR thread_sequence = ${threadSequence})
        ORDER BY sequence
      `;
      return hydrateMessages(db, teamId, rows);
    });
  }

  /** History and reactions share a revision, so clients can reject an overtaken page. */
  async getHistory(teamId: string, beforeSequence: number) {
    return inStateTransaction(this.db, async (db) => {
      const [team] = await db<{ revision: number }[]>`
        SELECT revision FROM teams WHERE id = ${teamId}
      `;
      return team
        ? {
            revision: team.revision,
            messages: await listMessagesBefore(db, teamId, beforeSequence),
          }
        : null;
    });
  }

  /**
   * Appends a user, Agent, or connector message, in a thread when it replies. The lead can flag
   * its own message as a request for the user.
   */
  async appendMessage({
    teamId,
    attachments,
    request,
    threadSequence,
    ...message
  }: Omit<TeamConversationMessage, "sequence" | "timestamp" | "reactions" | "request"> & {
    teamId: string;
    request?: boolean;
  }) {
    // A lead's Agent ID is its Team's ID.
    if (request && !(message.sender.type === "agent" && message.sender.agentId === teamId)) {
      throw new Error("Only the team lead can request input.");
    }
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, teamId);
      const thread =
        threadSequence === undefined
          ? undefined
          : await resolveThreadSequence(db, teamId, threadSequence);
      const acknowledgedRequest = message.sender.type === "user" && team.requestSequence !== null;
      const change = await appendMessage(db, teamId, (position) => ({
        ...message,
        ...position,
        ...(request ? { request: true as const } : {}),
        ...(thread === undefined ? {} : { threadSequence: thread }),
        ...(attachments?.length ? { attachments } : {}),
      }));
      return {
        ...(await recordTeamChange(db, team, [change])),
        message: change.message,
        acknowledgedRequest,
      };
    });
  }

  /** The team thread a connector conversation lives in. */
  async getConnectorThread(connectorId: string, conversationId: string) {
    const [row] = await this.db<{ team_id: string; thread_sequence: number }[]>`
      SELECT team_id, thread_sequence FROM team_connector_threads
      WHERE connector_id = ${connectorId} AND conversation_id = ${conversationId}
    `;
    return row ? { teamId: row.team_id, threadSequence: row.thread_sequence } : null;
  }

  /**
   * The conversation a team thread holds with a connector, recording `conversationId` when it has
   * none yet. Returns whichever conversation the thread holds after the write.
   */
  async claimConnectorConversation(input: {
    connectorId: string;
    conversationId: string;
    teamId: string;
    threadSequence: number;
  }): Promise<string> {
    const { connectorId, conversationId, teamId, threadSequence } = input;
    await this.db`
      INSERT INTO team_connector_threads (connector_id, conversation_id, team_id, thread_sequence)
      VALUES (${connectorId}, ${conversationId}, ${teamId}, ${threadSequence})
      ON CONFLICT DO NOTHING
    `;
    const [row] = await this.db<{ conversation_id: string }[]>`
      SELECT conversation_id FROM team_connector_threads
      WHERE connector_id = ${connectorId} AND team_id = ${teamId}
        AND thread_sequence = ${threadSequence}
    `;
    return row?.conversation_id ?? conversationId;
  }

  /** Notes in the transcript that a connector never received a message. */
  async noteConnectorUndelivered(
    teamId: string,
    content: Extract<TeamSystemMessageContent, { type: "connector_undelivered" }>,
  ) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, teamId);
      return recordTeamChange(db, team, [await appendSystemMessage(db, teamId, content)]);
    });
  }

  async setMessageReaction(input: {
    teamId: string;
    sequence: number;
    agentId: string;
    reaction: TeamReaction["reaction"] | null;
  }) {
    return inStateTransaction(this.db, async (db) => {
      let reaction: TeamReaction | null;
      if (input.reaction === null) {
        const rows = await db<{ agent_id: string }[]>`
          DELETE FROM team_message_reactions
          WHERE team_id = ${input.teamId}
            AND message_sequence = ${input.sequence}
            AND agent_id = ${input.agentId}
          RETURNING agent_id
        `;
        if (rows.length === 0) return null;
        reaction = null;
      } else {
        const [row] = await db<{ agent_id: string }[]>`
          INSERT INTO team_message_reactions (
            team_id, message_sequence, agent_id, reaction
          )
          SELECT ${input.teamId}, ${input.sequence}, ${input.agentId}, ${input.reaction}
          FROM team_messages
          WHERE team_id = ${input.teamId}
            AND sequence = ${input.sequence}
            AND sender_type <> 'system'
          ON CONFLICT(team_id, message_sequence, agent_id)
          DO UPDATE SET reaction = excluded.reaction
          RETURNING agent_id
        `;
        if (!row) throw new Error("React to a user or Agent message in this Team.");
        reaction = { agentId: row.agent_id, reaction: input.reaction };
      }
      return {
        teamId: input.teamId,
        reaction,
        events: [
          {
            type: "reaction" as const,
            sequence: input.sequence,
            agentId: input.agentId,
            reaction: input.reaction,
            revision: await advanceRevision(db, input.teamId),
          },
        ],
      };
    });
  }

  async listArtifacts(teamId: string): Promise<TeamArtifact[]> {
    return listArtifacts(this.db, teamId);
  }

  async shareArtifact(input: {
    teamId: string;
    file: TeamArtifact["file"];
    title: string;
    actor: Extract<TeamSystemMessageContent, { type: "artifact_shared" }>["actor"];
  }) {
    return inStateTransaction(this.db, async (db) => {
      const [row] = await db<TeamArtifactRow[]>`
        INSERT INTO team_artifacts (
          team_id, kind, session_id, path, title, created_at, position
        ) VALUES (
          ${input.teamId}, ${input.file.kind},
          ${input.file.kind === "session" ? input.file.sessionId : null},
          ${input.file.path}, ${input.title}, ${new Date().toISOString()},
          (
            SELECT COALESCE(MIN(position), 0) - 1 FROM team_artifacts
            WHERE team_id = ${input.teamId}
          )
        )
        ON CONFLICT DO UPDATE SET title = excluded.title
        WHERE team_artifacts.title <> excluded.title
        RETURNING kind, session_id, path, title, created_at, archived, pinned
      `;
      if (!row)
        return {
          teamId: input.teamId,
          events: [],
          artifact: { file: input.file, title: input.title },
        };
      const team = await requireTeam(db, input.teamId);
      const artifact = artifactFromRow(row);
      const change = await appendSystemMessage(db, input.teamId, {
        type: "artifact_shared",
        actor: input.actor,
        artifact: { file: artifact.file, title: artifact.title },
      });
      return { ...(await recordTeamChange(db, team, [change])), artifact };
    });
  }

  /** Quietly rearranges the user's artifacts; an arrangement that changes nothing is a no-op. */
  async arrangeArtifacts({ teamId, ...arrangement }: ArrangeTeamArtifactsInput) {
    return inStateTransaction(this.db, async (db) => {
      const current = await listArtifacts(db, teamId);
      const artifacts = applyTeamArtifactArrangement(current, arrangement);
      if (artifacts.every((artifact, index) => artifact === current[index])) {
        return { teamId, events: [] };
      }
      for (const [position, { file, archived, pinned }] of artifacts.entries()) {
        await db`
          UPDATE team_artifacts SET position = ${position}, archived = ${archived ? 1 : 0},
            pinned = ${pinned ? 1 : 0}
          WHERE team_id = ${teamId} AND kind = ${file.kind} AND path = ${file.path}
            AND session_id IS ${file.kind === "session" ? file.sessionId : null}
        `;
      }
      return {
        teamId,
        events: [
          {
            type: "artifacts" as const,
            artifacts,
            revision: await advanceRevision(db, teamId),
          },
        ],
      };
    });
  }

  async listRoutines(teamId: string): Promise<TeamRoutine[]> {
    return listRoutines(this.db, teamId);
  }

  /** Adds a routine to the lead's Team, or changes one. An identical change is a no-op. */
  async setRoutine(leadId: string, { routineId, ...input }: SetTeamRoutineInput) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireLeadTeam(db, leadId);
      const routine = { id: routineId ?? crypto.randomUUID(), ...input };
      const nextAt = nextCronOccurrence(input.schedule, new Date()).toISOString();
      if (routineId) {
        const [current] = await db<TeamRoutine[]>`
          SELECT id, title, schedule, prompt FROM team_routines
          WHERE id = ${routineId} AND team_id = ${team.id}
        `;
        if (!current) throw new Error("Routine not found in this team.");
        if (Bun.deepEquals(current, routine)) {
          return { teamId: team.id, events: [], routine };
        }
        await db`
          UPDATE team_routines SET ${db({ ...input, next_at: nextAt })} WHERE id = ${routineId}
        `;
      } else {
        await db`
          INSERT INTO team_routines ${db({
            ...routine,
            team_id: team.id,
            next_at: nextAt,
            created_at: new Date().toISOString(),
          })}
        `;
      }
      const change = await appendSystemMessage(db, team.id, {
        type: routineId ? "routine_edited" : "routine_scheduled",
        routine,
      });
      return { ...(await recordTeamChange(db, team, [change])), routine };
    });
  }

  /** Deletes a routine, or returns null when it's already gone. */
  async deleteRoutine(teamId: string, routineId: string) {
    return inStateTransaction(this.db, async (db) => {
      const [row] = await db<TeamRoutine[]>`
        DELETE FROM team_routines WHERE id = ${routineId} AND team_id = ${teamId}
        RETURNING id, title, schedule, prompt
      `;
      if (!row) return null;
      const team = await requireTeam(db, teamId);
      const change = await appendSystemMessage(db, teamId, {
        type: "routine_deleted",
        routine: row,
      });
      return recordTeamChange(db, team, [change]);
    });
  }

  /**
   * Claims every due follow-up and routine, so each wakes its lead once. A follow-up clears its
   * waiting status. A routine moves past `now`, so runs missed while stopped collapse into one.
   */
  async claimDueWakes(now: Date) {
    return inStateTransaction(this.db, async (db) => {
      const workers = new WorkerDatabase(db);
      const pausedTeams = new Set(
        (await db<{ id: string }[]>`SELECT id FROM teams WHERE paused = 1`).map(({ id }) => id),
      );
      const followUps = [];
      for (const worker of await workers.list("team")) {
        if (pausedTeams.has(worker.teamId)) continue;
        const metadata = teamAgentMetadataSchema.parse(worker.metadata);
        const { status } = metadata;
        if (status?.state !== "waiting" || !status.wakeAt || new Date(status.wakeAt) > now)
          continue;
        await workers.update(worker.sessionId, {
          metadata: applyPatch(metadata, { status: null }),
        });
        const revision = await advanceRevision(db, worker.teamId);
        followUps.push({
          agentId: worker.sessionId,
          change: {
            teamId: worker.teamId,
            events: [{ type: "status" as const, agentId: worker.sessionId, revision }],
          },
          waitingFor: status.text,
        });
      }
      const routines = await db<(TeamRoutine & { team_id: string })[]>`
        SELECT id, team_id, title, schedule, prompt FROM team_routines
        WHERE next_at <= ${now.toISOString()}
          AND team_id IN (SELECT id FROM teams WHERE paused = 0)
      `;
      for (const { id, schedule } of routines) {
        await db`
          UPDATE team_routines
          SET next_at = ${nextCronOccurrence(schedule, now).toISOString()}
          WHERE id = ${id}
        `;
      }
      return {
        followUps,
        routines: routines.map(({ team_id, title, prompt }) => ({
          teamId: team_id,
          title,
          prompt,
        })),
      };
    });
  }
}

async function advanceRevision(db: Bun.SQL, teamId: string): Promise<number> {
  const [team] = await db<Pick<TeamRow, "revision">[]>`
    UPDATE teams SET revision = revision + 1 WHERE id = ${teamId} RETURNING revision
  `;
  if (!team) throw new Error("Team not found.");
  return team.revision;
}

/** Fold this transaction's events into metadata and persist their attention cursors. */
async function recordTeamChange<Event extends TeamEvent>(
  db: Bun.SQL,
  previous: Team,
  events: Event[],
) {
  const team = events.reduce(reduceTeam, previous);
  if (
    team.requestSequence !== previous.requestSequence ||
    team.completedSequence !== previous.completedSequence
  ) {
    await db`
      UPDATE teams
      SET request_sequence = ${team.requestSequence},
        completed_sequence = ${team.completedSequence}
      WHERE id = ${team.id}
    `;
  }
  return { teamId: team.id, events, team };
}

async function updateTeamFields(
  db: Bun.SQL,
  current: Team,
  changes: TeamChanges & { paused?: boolean },
  actor: TeamMessageActor,
) {
  if (changes.model && changes.model.provider !== current.model.provider) {
    throw new Error("The lead's provider cannot change without losing its session history.");
  }
  const next = applyPatch(current, changes);
  const events: TeamEvent[] = [];
  if (Bun.deepEquals(next, current)) {
    return { ...(await recordTeamChange(db, current, events)), purposeChanged: false };
  }
  const updates: TeamSystemMessageContent[] = [];
  if (next.paused !== current.paused) updates.push({ type: "team_paused", paused: next.paused });
  if (next.name !== current.name) updates.push({ type: "team_renamed", actor, name: next.name });
  if (next.purpose !== current.purpose)
    updates.push({ type: "team_purpose_changed", actor, purpose: next.purpose ?? null });
  if (next.directory !== current.directory)
    updates.push({ type: "team_directory_changed", actor, directory: next.directory ?? null });
  if (!Bun.deepEquals(next.preview, current.preview))
    updates.push({ type: "preview_changed", actor, preview: next.preview ?? null });
  if (next.canvasArtifactId !== current.canvasArtifactId)
    updates.push({
      type: "canvas_changed",
      actor,
      canvasArtifactId: next.canvasArtifactId ?? null,
    });
  if (!teamTasksComplete(current.tasks) && teamTasksComplete(next.tasks))
    updates.push({ type: "tasks_completed" });
  // User edits count as activity; task revisions alone stay quiet.
  const updatedAt = actor.type === "user" ? new Date().toISOString() : current.updatedAt;
  await db`
    UPDATE teams SET ${db({
      ...teamColumns(next),
      updated_at: updatedAt,
    })}
    WHERE id = ${current.id}
  `;
  if (!Bun.deepEquals(next.tasks, current.tasks)) {
    events.push({
      type: "tasks",
      revision: await advanceRevision(db, current.id),
      tasks: next.tasks,
    });
  }
  if (!Bun.deepEquals(next.model, current.model)) {
    events.push({
      type: "model",
      revision: await advanceRevision(db, current.id),
      model: next.model,
      updatedAt,
    });
  }
  for (const content of updates) {
    events.push(await appendSystemMessage(db, current.id, content));
  }
  return {
    ...(await recordTeamChange(db, current, events)),
    purposeChanged: next.purpose !== current.purpose,
  };
}

function teamColumns(
  team: Pick<
    Team,
    "name" | "paused" | "purpose" | "directory" | "model" | "tasks" | "preview" | "canvasArtifactId"
  >,
) {
  return {
    name: team.name,
    paused: team.paused ? 1 : 0,
    purpose: team.purpose ?? null,
    directory: team.directory ?? null,
    model: JSON.stringify(team.model),
    tasks: JSON.stringify(team.tasks),
    preview: team.preview ? JSON.stringify(team.preview) : null,
    canvas_artifact_id: team.canvasArtifactId ?? null,
  };
}

function appendSystemMessage(db: Bun.SQL, teamId: string, content: TeamSystemMessageContent) {
  return appendMessage(db, teamId, (position) => ({
    ...position,
    id: crypto.randomUUID(),
    sender: { type: "system" },
    content,
  }));
}

async function appendMessage<Message extends TeamMessage>(
  db: Bun.SQL,
  teamId: string,
  build: (position: Pick<TeamMessage, "sequence" | "timestamp">) => Message,
) {
  const now = new Date().toISOString();
  const [team] = await db<Pick<TeamRow, "latest_sequence" | "revision">[]>`
    UPDATE teams
    SET
      latest_sequence = latest_sequence + 1,
      revision = revision + 1,
      updated_at = ${now}
    WHERE id = ${teamId}
    RETURNING latest_sequence, revision
  `;
  if (!team) throw new Error("Team not found.");
  const message = build({
    sequence: team.latest_sequence,
    timestamp: now,
  });
  await db`
    INSERT INTO team_messages ${db({ team_id: teamId, ...messageColumns(message) })}
  `;
  return {
    type: "message" as const,
    message,
    revision: team.revision,
  };
}

function messageColumns(message: TeamMessage) {
  return {
    id: message.id,
    sequence: message.sequence,
    timestamp: message.timestamp,
    sender_type: message.sender.type,
    sender_agent_id: message.sender.type === "agent" ? message.sender.agentId : null,
    sender_connector_id: message.sender.type === "connector" ? message.sender.connectorId : null,
    content:
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    attachments: message.attachments?.length ? JSON.stringify(message.attachments) : null,
    origin: !isTeamSystemMessage(message) && message.origin ? JSON.stringify(message.origin) : null,
    request: message.request ? 1 : 0,
    thread_sequence: message.threadSequence ?? null,
  };
}

/** Replying within a thread joins it, so threads stay one level deep. */
async function resolveThreadSequence(
  db: Bun.SQL,
  teamId: string,
  sequence: number,
): Promise<number> {
  const [row] = await db<Pick<TeamMessageRow, "sender_type" | "thread_sequence">[]>`
    SELECT sender_type, thread_sequence FROM team_messages
    WHERE team_id = ${teamId} AND sequence = ${sequence}
  `;
  if (!row || row.sender_type === "system") {
    throw new Error("Reply to a user or agent message in this team.");
  }
  return row.thread_sequence ?? sequence;
}

async function changeAgentStatus(
  db: Bun.SQL,
  agentId: string,
  status: TeamAgentStatus | undefined,
  required: boolean,
  requiredState?: TeamAgentStatus["state"],
) {
  return inStateTransaction(db, async (transaction) => {
    const worker = await new WorkerDatabase(transaction).get(agentId, "team");
    if (!worker) {
      if (required) throw new Error("Team agent not found.");
      return null;
    }
    const metadata = teamAgentMetadataSchema.parse(worker.metadata);
    if (requiredState && metadata.status?.state !== requiredState) return null;
    if (Bun.deepEquals(metadata.status, status)) return null;
    await new WorkerDatabase(transaction).update(worker.sessionId, {
      metadata: applyPatch(metadata, { status: status ?? null }),
    });
    return {
      teamId: worker.teamId,
      events: [
        {
          type: "status" as const,
          agentId,
          status,
          revision: await advanceRevision(transaction, worker.teamId),
        },
      ],
    };
  });
}

async function getAgent(db: Bun.SQL, agentId: string) {
  const worker = await new WorkerDatabase(db).get(agentId, "team");
  if (!worker) return null;
  return teamAgentFromWorker(worker);
}

/** Request content is retained even when its message has left the snapshot window. */
async function readRequest(
  db: Bun.SQL,
  teamId: string,
  sequence: number,
): Promise<TeamConversationMessage | null> {
  const rows = await db<TeamMessageRow[]>`
    SELECT * FROM team_messages WHERE team_id = ${teamId} AND sequence = ${sequence}
  `;
  const message = (await hydrateMessages(db, teamId, rows))[0];
  return message && !isTeamSystemMessage(message) ? message : null;
}

async function listMessagesBefore(
  db: Bun.SQL,
  teamId: string,
  beforeSequence?: number,
  limit = 100,
): Promise<TeamMessage[]> {
  const before = beforeSequence ?? Number.MAX_SAFE_INTEGER;
  const rows = await db<TeamMessageRow[]>`
    SELECT * FROM team_messages
    WHERE team_id = ${teamId} AND sequence < ${before}
    ORDER BY sequence DESC
    LIMIT ${limit}
  `;
  return hydrateMessages(db, teamId, rows.reverse());
}

async function hydrateMessages(
  db: Bun.SQL,
  teamId: string,
  rows: TeamMessageRow[],
): Promise<TeamMessage[]> {
  const firstSequence = rows[0]?.sequence;
  const lastSequence = rows.at(-1)?.sequence;
  if (firstSequence === undefined || lastSequence === undefined) return [];
  const reactionRows = await db<TeamReactionRow[]>`
    SELECT message_sequence, agent_id, reaction FROM team_message_reactions
    WHERE team_id = ${teamId}
      AND message_sequence >= ${firstSequence}
      AND message_sequence <= ${lastSequence}
    ORDER BY message_sequence, agent_id
  `;
  const reactions = reactionsByMessage(reactionRows);
  return rows.map((row) => messageFromRow(row, reactions.get(row.sequence) ?? []));
}

async function listArtifacts(db: Bun.SQL, teamId: string): Promise<TeamArtifact[]> {
  const rows = await db<TeamArtifactRow[]>`
    SELECT kind, session_id, path, title, created_at, archived, pinned FROM team_artifacts
    WHERE team_id = ${teamId}
    ORDER BY pinned DESC, position
  `;
  return rows.map(artifactFromRow);
}

async function listRoutines(db: Bun.SQL, teamId: string): Promise<TeamRoutine[]> {
  return db<TeamRoutine[]>`
    SELECT id, title, schedule, prompt FROM team_routines
    WHERE team_id = ${teamId}
    ORDER BY created_at, id
  `;
}

type TeamRow = {
  id: string;
  name: string;
  purpose: string | null;
  paused: number;
  directory: string | null;
  model: string;
  tasks: string;
  preview: string | null;
  canvas_artifact_id: string | null;
  latest_sequence: number;
  revision: number;
  seen_through: number;
  request_sequence: number | null;
  completed_sequence: number | null;
  updated_at: string;
};

type TeamMessageRow = {
  id: string;
  team_id: string;
  sequence: number;
  sender_type: TeamMessageSender["type"];
  sender_agent_id: string | null;
  sender_connector_id: string | null;
  content: string;
  request: number;
  attachments: string | null;
  origin: string | null;
  thread_sequence: number | null;
  timestamp: string;
};

type TeamReactionRow = {
  message_sequence: number;
  agent_id: string;
  reaction: TeamReaction["reaction"];
};

type TeamArtifactRow = {
  path: string;
  title: string;
  created_at: string;
  archived: number;
  pinned: number;
} & ({ kind: "session"; session_id: string } | { kind: "machine"; session_id: null });

async function readTeamRows(db: Bun.SQL, teamId?: string) {
  const where = teamId === undefined ? db`` : db`WHERE id = ${teamId}`;
  return db<TeamRow[]>`
    SELECT * FROM teams
    ${where}
    ORDER BY updated_at DESC, id
  `;
}

function teamFromRow(row: TeamRow): Team {
  return {
    id: row.id,
    name: row.name,
    paused: row.paused === 1,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(row.directory ? { directory: row.directory } : {}),
    model: modelConfigurationSchema.parse(JSON.parse(row.model)),
    tasks: teamTasksSchema.parse(JSON.parse(row.tasks)),
    ...(row.preview ? { preview: previewSchema.parse(JSON.parse(row.preview)) } : {}),
    ...(row.canvas_artifact_id ? { canvasArtifactId: row.canvas_artifact_id } : {}),
    latestSequence: row.latest_sequence,
    seenThrough: row.seen_through,
    completedSequence: row.completed_sequence,
    requestSequence: row.request_sequence,
    updatedAt: row.updated_at,
  };
}

async function requireTeamWorker(
  db: Bun.SQL,
  sessionId: string,
): Promise<Extract<Worker, { type: "team" }>> {
  const worker = await new WorkerDatabase(db).get(sessionId, "team");
  if (!worker) throw new Error("Team agent not found.");
  return worker;
}

async function requireTeamMemberWorker(
  db: Bun.SQL,
  sessionId: string,
): Promise<Extract<Worker, { type: "team" }>> {
  const worker = await requireTeamWorker(db, sessionId);
  if (isTeamLead(worker)) throw new Error("Team member not found.");
  return worker;
}

async function requireTeam(db: Bun.SQL, teamId: string): Promise<Team> {
  const [row] = await readTeamRows(db, teamId);
  if (!row) throw new Error("Team not found.");
  return teamFromRow(row);
}

async function requireLeadTeam(db: Bun.SQL, leadId: string): Promise<Team> {
  const [row] = await readTeamRows(db, leadId);
  if (!row) throw new Error("Only the team lead can update the team.");
  return teamFromRow(row);
}

async function assertMemberNameAvailable(
  db: Bun.SQL,
  teamId: string,
  name: string | undefined,
  exceptSessionId?: string,
): Promise<void> {
  if (!name) throw new Error("Team members require a name.");
  const handle = agentHandleFromName(name);
  if (handle === agentHandleFromName(TEAM_LEAD_PROFILE.name)) {
    throw new Error(`The intrinsic lead already uses the @${handle} mention.`);
  }
  const workers = await new WorkerDatabase(db).list({ type: "team", teamId });
  const conflict = workers.find(
    (worker) =>
      !isTeamLead(worker) &&
      worker.sessionId !== exceptSessionId &&
      worker.name &&
      agentHandleFromName(worker.name) === handle,
  );
  if (conflict) throw new Error(`${conflict.name} already uses the @${handle} mention.`);
}

function artifactFromRow(row: TeamArtifactRow): TeamArtifact {
  const file =
    row.kind === "session" ? sessionFile(row.session_id, row.path) : machineFile(row.path);
  return {
    id: workspaceFileId(file),
    file,
    title: row.title,
    sharedAt: row.created_at,
    ...(row.archived ? { archived: true } : {}),
    ...(row.pinned ? { pinned: true } : {}),
  };
}

function messageFromRow(row: TeamMessageRow, reactions: TeamReaction[]): TeamMessage {
  const common = {
    id: row.id,
    sequence: row.sequence,
    timestamp: row.timestamp,
  };
  if (row.sender_type === "system") {
    return {
      ...common,
      sender: { type: "system" },
      content: teamSystemMessageContentSchema.parse(JSON.parse(row.content)),
    };
  }

  const attachments = row.attachments
    ? teamAttachmentSchema.array().parse(JSON.parse(row.attachments))
    : undefined;
  return {
    ...common,
    sender: authorFromRow(row),
    content: row.content,
    ...(row.origin ? { origin: connectorOriginSchema.parse(JSON.parse(row.origin)) } : {}),
    ...(row.request ? { request: true as const } : {}),
    ...(row.thread_sequence === null ? {} : { threadSequence: row.thread_sequence }),
    ...(attachments?.length ? { attachments } : {}),
    ...(reactions.length ? { reactions } : {}),
  };
}

function authorFromRow(
  row: Pick<TeamMessageRow, "sender_type" | "sender_agent_id" | "sender_connector_id">,
): TeamMessageAuthor {
  switch (row.sender_type) {
    case "agent":
      return { type: "agent", agentId: row.sender_agent_id! };
    case "connector":
      return { type: "connector", connectorId: row.sender_connector_id! };
    default:
      return { type: "user" };
  }
}

function reactionsByMessage(rows: TeamReactionRow[]): Map<number, TeamReaction[]> {
  const reactions = new Map<number, TeamReaction[]>();
  for (const row of rows) {
    const messageReactions = reactions.get(row.message_sequence) ?? [];
    messageReactions.push({ agentId: row.agent_id, reaction: row.reaction });
    reactions.set(row.message_sequence, messageReactions);
  }
  return reactions;
}

async function assertTaskReferences(
  db: Bun.SQL,
  teamId: string,
  tasks: readonly TeamTask[],
  previousTasks: readonly TeamTask[] = [],
): Promise<void> {
  const [agents, artifacts] = await Promise.all([
    new WorkerDatabase(db).list({ type: "team", teamId }),
    listArtifacts(db, teamId),
  ]);
  const agentIds = new Set(agents.map(({ sessionId }) => sessionId));
  const artifactIds = new Set(artifacts.map(({ id }) => id));
  const previous = new Map<string, TeamTask>();
  const indexPrevious = (tasks: readonly TeamTask[]) => {
    for (const task of tasks) {
      previous.set(task.id, task);
      if (task.children) indexPrevious(task.children);
    }
  };
  indexPrevious(previousTasks);
  const visit = (tasks: readonly TeamTask[]) => {
    for (const task of tasks) {
      const before = previous.get(task.id);
      if (task.ownerId && task.ownerId !== before?.ownerId && !agentIds.has(task.ownerId)) {
        throw new Error("Task owners must be the team lead or a current member.");
      }
      if (
        task.artifactId &&
        task.artifactId !== before?.artifactId &&
        !artifactIds.has(task.artifactId)
      ) {
        throw new Error(`Task "${task.id}" must reference an artifact shared in this team.`);
      }
      if (task.children) visit(task.children);
    }
  };
  visit(tasks);
}
