import {
  agentHandleFromName,
  avatarSchema,
  teamAgentMetadataSchema,
  teamHandle,
  isTeamSystemMessage,
  applyTeamTaskEdits,
  applyTeamArtifactArrangement,
  orderTeamTasks,
  teamTasksComplete,
  teamTaskPrioritySchema,
  teamTaskStatusSchema,
  teamTurnReportsDue,
  assertTeamTurnReports,
  TEAM_TASK_CONTINUE_LIMIT,
  mentionsTeamTask,
  teamSystemMessageContentSchema,
  connectorCoordinatorsSchema,
  TEAM_LEAD_PROFILE,
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
  type TeamTaskReport,
  type TeamRoutine,
  type CreateTeamInput,
  type EditTeamInput,
  type EditTeamTasksInput,
  type SetTeamRoutineInput,
  type UpdateTeamInput,
} from "@teams/model";
import { reduceTeam } from "@teams/model/reducer";
import {
  orderTeamAdvice,
  teamAdviceActionSchema,
  type ProposeTeamAdviceInput,
  type TeamAdvice,
} from "@teams/model/advice";
import { applyPatch } from "@teams/model/changes";
import { previewSchema } from "@/shared/preview";
import { diffStatsSchema } from "@/shared/diffStats";
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
import type { TeamMessageLocation, TeamMessageMatch } from "@teams/model/search";
import type { TeamWake } from "@teams/model/performance";
import { ADMIN_TEAM_ID } from "@teams/model/admin";

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
      await assertTeamNameAvailable(db, input.name);
      await db`
        INSERT INTO teams ${db({
          id,
          ...teamColumns({ ...input, paused: false }),
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

  /** Apply a default only while no authored avatar exists. */
  async initializeAvatar(teamId: string, avatar: NonNullable<Team["avatar"]>) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, teamId);
      return updateTeamFields(db, team, team.avatar ? {} : { avatar }, {
        type: "agent",
        agentId: teamId,
      });
    });
  }

  async editTeam({ teamId, ...changes }: EditTeamInput) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, teamId);
      return updateTeamFields(db, team, changes, { type: "user" });
    });
  }

  async deleteTeam(teamId: string): Promise<string[] | null> {
    if (teamId === ADMIN_TEAM_ID)
      throw new Error("The built-in Admin team cannot be deleted. Pause it instead.");
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
        tasks: await listTasks(db, teamId),
        artifacts: await listArtifacts(db, teamId),
        routines: await listRoutines(db, teamId),
        advice: await listAdvice(db, teamId),
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
      const coordinators = input.connectorCoordinators;
      if (coordinators) {
        const members = await new TeamDatabase(db).listMembers(team.id);
        const agentIds = new Set([team.id, ...members.map(({ id }) => id)]);
        const outsider = Object.values(coordinators).find((agentId) => !agentIds.has(agentId));
        if (outsider) throw new Error(`Agent ${outsider} is not on this team.`);
      }
      return updateTeamFields(
        db,
        team,
        // An empty map leaves every connector to the lead, as no map does.
        coordinators && !Object.keys(coordinators).length
          ? { ...input, connectorCoordinators: null }
          : input,
        { type: "agent", agentId: leadId },
      );
    });
  }

  async listTasks(teamId: string): Promise<TeamTask[]> {
    return listTasks(this.db, teamId);
  }

  /**
   * Applies an ordered task batch with the editing agent's authority, as `editTasks` describes.
   * Returns the tasks before and after, and the notes, for deciding whom the change wakes.
   */
  async editTasks(agentId: string, { operations }: EditTeamTasksInput) {
    return inStateTransaction(this.db, async (db) => {
      const worker = await requireTeamWorker(db, agentId);
      const team = await requireTeam(db, worker.teamId);
      const { events, ...edit } = await editTasks(db, team.id, worker, operations);
      return { ...(await recordTeamChange(db, team, events)), ...edit };
    });
  }

  /** Adds the agent's own open tasks among these to its turn, which its finish reports on. */
  async addTurnTasks(agentId: string, taskIds: readonly string[]) {
    if (taskIds.length === 0) return null;
    return inStateTransaction(this.db, async (db) => {
      const worker = await new WorkerDatabase(db).get(agentId, "team");
      if (!worker) return null;
      const team = await requireTeam(db, worker.teamId);
      const { turnTasks = [] } = teamAgentMetadataSchema.parse(worker.metadata);
      const added = teamTurnReportsDue(await listTasks(db, team.id), agentId, taskIds)
        .map(({ id }) => id)
        .filter((id) => !turnTasks.includes(id));
      if (added.length === 0) return null;
      const events = await changeAgentActivity(db, worker, { turnTasks: [...turnTasks, ...added] });
      return recordTeamChange(db, team, events);
    });
  }

  /**
   * Finishes an agent's turn. Its reports apply as one task edit with its authority, each note
   * posting into its task's thread, and each schedules its task's continuation or clears it. The
   * finish reports on every task its turn is due to, and continues a task only so many times in a
   * row. Clears the turn's tasks and leaves the waiting status, or none.
   */
  async finishTurn(
    agentId: string,
    reports: readonly TeamTaskReport[],
    waiting?: Extract<TeamAgentStatus, { state: "waiting" }>,
  ) {
    return inStateTransaction(this.db, async (db) => {
      const worker = await new WorkerDatabase(db).get(agentId, "team");
      if (!worker) {
        if (reports.length) throw new Error("Team agent not found.");
        return null;
      }
      const team = await requireTeam(db, worker.teamId);
      const { turnTasks } = teamAgentMetadataSchema.parse(worker.metadata);
      const tasks = await listTasks(db, team.id);
      assertTeamTurnReports(teamTurnReportsDue(tasks, agentId, turnTasks), reports);
      await assertContinuations(db, team.id, tasks, reports);
      const { events, ...edit } = await editTasks(
        db,
        team.id,
        worker,
        reports.map(({ taskId, status, note }) => ({
          type: "update" as const,
          taskId,
          patch: { status },
          note,
        })),
      );
      for (const { taskId, continueAfterMinutes } of reports) {
        const continueAt = continueAfterMinutes
          ? new Date(Date.now() + continueAfterMinutes * 60_000).toISOString()
          : null;
        await db`
          UPDATE team_tasks
          SET continue_at = ${continueAt},
            continues = CASE WHEN ${continueAt} IS NULL THEN 0 ELSE continues + 1 END,
            unreported_turns = 0
          WHERE team_id = ${team.id} AND id = ${taskId}
        `;
      }
      events.push(
        ...(await changeAgentActivity(db, worker, { status: waiting ?? null, turnTasks: null })),
      );
      return { ...(await recordTeamChange(db, team, events)), ...edit };
    });
  }

  /**
   * Ends an agent's turn that finished without its reports: clears the turn's tasks, and posts a
   * note in the thread of each it was due to report on, saying the turn ended without a report,
   * failed, or was stopped. Returns those tasks, and, when it ended without a report, those for
   * which this is the first such turn in a row, whose assignee wakes once more.
   */
  async endTurn(
    agentId: string,
    outcome: Extract<TeamSystemMessageContent, { type: "task_turn_ended" }>["outcome"],
    error?: string,
  ) {
    return inStateTransaction(this.db, async (db) => {
      const worker = await new WorkerDatabase(db).get(agentId, "team");
      const turnTasks = worker && teamAgentMetadataSchema.parse(worker.metadata).turnTasks;
      if (!worker || !turnTasks) return null;
      const team = await requireTeam(db, worker.teamId);
      const before = await listTasks(db, team.id);
      const events: TeamEvent[] = [];
      const due: TeamTask[] = [];
      const rewake: TeamTask[] = [];
      for (const task of teamTurnReportsDue(before, agentId, turnTasks)) {
        const thread = await openTaskThread(db, team.id, task);
        events.push(...thread.events);
        due.push(thread.task);
        events.push(
          await appendSystemMessage(
            db,
            team.id,
            {
              type: "task_turn_ended",
              taskId: task.id,
              agentId,
              outcome,
              ...(error ? { error: error.slice(0, 1_000) } : {}),
            },
            { threadSequence: thread.task.threadSequence },
          ),
        );
        if (outcome !== "unreported") continue;
        const [row] = await db<Pick<TeamTaskRow, "unreported_turns">[]>`
          UPDATE team_tasks SET unreported_turns = unreported_turns + 1
          WHERE team_id = ${team.id} AND id = ${task.id}
          RETURNING unreported_turns
        `;
        if (row!.unreported_turns === 1) rewake.push(thread.task);
      }
      const after = before.map((task) => due.find(({ id }) => id === task.id) ?? task);
      events.push(...(await saveTasks(db, team.id, before, after)));
      events.push(...(await changeAgentActivity(db, worker, { turnTasks: null })));
      return {
        ...(await recordTeamChange(db, team, events)),
        isLead: isTeamLead(worker),
        tasks: due,
        rewake,
      };
    });
  }

  /** The lead settles every pending request without the user; with none pending, nothing changes. */
  async resolveRequests(leadId: string) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireLeadTeam(db, leadId);
      return recordTeamChange(
        db,
        team,
        team.requestSequence === null
          ? []
          : [await appendSystemMessage(db, team.id, { type: "requests_resolved" })],
      );
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
      const events = await releaseTasks(db, member.teamId, [agentId]);
      const routines = await db<TeamRoutineRow[]>`
        DELETE FROM team_routines WHERE team_id = ${member.teamId} AND agent_id = ${agentId}
        RETURNING id, title, schedule, prompt, agent_id
      `;
      for (const routine of routines) {
        events.push(
          await appendSystemMessage(db, member.teamId, {
            type: "routine_deleted",
            routine: routineFromRow(routine),
          }),
        );
      }
      const change = await appendSystemMessage(db, member.teamId, {
        type: "member_left",
        member,
      });
      return { ...(await recordTeamChange(db, team, [...events, change])), member };
    });
  }

  async listAgentIds(teamId: string): Promise<string[]> {
    return (await new WorkerDatabase(this.db).list({ type: "team", teamId }))
      .map(({ sessionId }) => sessionId)
      .sort();
  }

  /**
   * Moves members, never a lead, to another team with their Sessions intact. The source releases
   * their tasks and deletes their routines, as removal does; the target receives them reading from
   * its latest message. Each team records the change in its own transcript.
   */
  async moveMembers(sourceTeamId: string, agentIds: readonly string[], targetTeamId: string) {
    return inStateTransaction(this.db, async (db) => {
      const workers = new WorkerDatabase(db);
      const source = await requireTeam(db, sourceTeamId);
      const target = await requireTeam(db, targetTeamId);
      if (source.id === target.id) throw new Error("Move members to a different team.");
      if (target.paused) throw new Error("Resume the team before adding an agent.");
      const moving: Extract<Worker, { type: "team" }>[] = [];
      for (const agentId of agentIds) {
        const worker = await workers.get(agentId, "team");
        if (!worker || worker.teamId !== source.id || isTeamLead(worker)) {
          throw new Error("Move only this team's current members, never its lead.");
        }
        await assertMemberNameAvailable(db, target.id, worker.name);
        moving.push(worker);
      }

      const sourceEvents = await releaseTasks(
        db,
        source.id,
        moving.map(({ sessionId }) => sessionId),
      );
      const targetEvents: TeamEvent[] = [];
      for (const worker of moving) {
        const routines = await db<TeamRoutineRow[]>`
          DELETE FROM team_routines WHERE team_id = ${source.id} AND agent_id = ${worker.sessionId}
          RETURNING id, title, schedule, prompt, agent_id
        `;
        for (const routine of routines) {
          sourceEvents.push(
            await appendSystemMessage(db, source.id, {
              type: "routine_deleted",
              routine: routineFromRow(routine),
            }),
          );
        }
        sourceEvents.push(
          await appendSystemMessage(db, source.id, {
            type: "member_left",
            member: teamMemberFromWorker(worker),
          }),
        );
        const { status: _status, ...metadata } = teamAgentMetadataSchema.parse(worker.metadata);
        await workers.moveToTeam(worker.sessionId, target.id);
        await workers.update(worker.sessionId, {
          metadata: { ...metadata, seenThrough: target.latestSequence },
        });
        targetEvents.push(
          await appendSystemMessage(db, target.id, {
            type: "member_joined",
            member: teamMemberFromWorker({ ...worker, teamId: target.id }, metadata),
          }),
        );
      }
      return {
        source: await recordTeamChange(db, source, sourceEvents),
        target: await recordTeamChange(db, target, targetEvents),
      };
    });
  }

  /** Conversation messages from `since` on, without reactions, for measuring the team. */
  async listConversationSince(teamId: string, since: string): Promise<TeamMessage[]> {
    const rows = await this.db<TeamMessageRow[]>`
      SELECT * FROM team_messages
      WHERE team_id = ${teamId} AND sender_type <> 'system' AND timestamp >= ${since}
      ORDER BY sequence
    `;
    return rows.map((row) => messageFromRow(row, []));
  }

  /** Records how waking one agent was delivered, for measuring the team. */
  async recordWake(teamId: string, wake: TeamWake & { messageSequence?: number }): Promise<void> {
    await this.db`
      INSERT INTO team_wakes ${this.db({
        team_id: teamId,
        agent_id: wake.agentId,
        at: wake.at,
        cause: wake.cause,
        author: wake.author ?? null,
        message_sequence: wake.messageSequence ?? null,
        disposition: wake.delivery,
      })}
    `;
  }

  async listWakesSince(teamId: string, since: string): Promise<TeamWake[]> {
    const rows = await this.db<
      {
        agent_id: string;
        at: string;
        cause: TeamWake["cause"];
        author: string | null;
        disposition: TeamWake["delivery"];
      }[]
    >`
      SELECT agent_id, at, cause, author, disposition FROM team_wakes
      WHERE team_id = ${teamId} AND at >= ${since}
      ORDER BY at
    `;
    return rows.map(({ agent_id, at, cause, author, disposition }) => ({
      agentId: agent_id,
      at,
      cause,
      ...(author === null ? {} : { author }),
      delivery: disposition,
    }));
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
    for await (const row of conversationNewestFirst(this.db, teamId, { thread })) {
      const match = findMatch(row.content);
      if (!match) continue;
      matches.push({ ...messageLocation(row), sender: authorFromRow(row), ...match });
      if (matches.length === MESSAGE_SEARCH_LIMIT) break;
    }
    return matches;
  }

  /** The newest conversation message that cites a task by its ID, and where it is. */
  async findTaskMessage(teamId: string, taskId: string): Promise<TeamMessageLocation | null> {
    await requireTeam(this.db, teamId);
    for await (const row of conversationNewestFirst(this.db, teamId, { containing: taskId })) {
      if (mentionsTeamTask(row.content, taskId)) return messageLocation(row);
    }
    return null;
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
   * Appends a user, Agent, connector, or team message, in a thread when it replies. The lead can
   * flag its own message as a request for the user.
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
        // The task whose thread holds the message, which decides whom it notifies.
        task: thread === undefined ? undefined : await taskByThread(db, teamId, thread),
      };
    });
  }

  /** The agent that wrote a team's message, or undefined when no agent of this team wrote it. */
  async agentAuthorOf(teamId: string, messageId: string): Promise<string | undefined> {
    const [row] = await this.db<{ sender_agent_id: string }[]>`
      SELECT sender_agent_id FROM team_messages
      WHERE team_id = ${teamId} AND id = ${messageId} AND sender_type = 'agent'
    `;
    return row?.sender_agent_id;
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

  /**
   * What passed between teams and a connector from `since` on, for its use: its events, the user and
   * agent messages in its threads (which `content` shows whether they addressed it), the messages it
   * never received, and the start of each of its threads with any message since.
   */
  async listConnectorUse(connectorId: string, since: string) {
    const [received, written, undelivered, threads] = await Promise.all([
      this.db<{ team_id: string; thread_sequence: number; timestamp: string }[]>`
        SELECT team_id, COALESCE(thread_sequence, sequence) AS thread_sequence, timestamp
        FROM team_messages
        WHERE sender_type = 'connector' AND sender_connector_id = ${connectorId}
          AND timestamp >= ${since}
      `,
      this.db<{ team_id: string; thread_sequence: number; timestamp: string; content: string }[]>`
        SELECT message.team_id, thread.thread_sequence, message.timestamp,
          substr(message.content, 1, 1000) AS content
        FROM team_messages AS message
        JOIN team_connector_threads AS thread
          ON thread.team_id = message.team_id
          AND thread.thread_sequence = COALESCE(message.thread_sequence, message.sequence)
        WHERE thread.connector_id = ${connectorId} AND message.sender_type IN ('user', 'agent')
          AND message.timestamp >= ${since}
      `,
      this.db<{ team_id: string; thread_sequence: number | null; timestamp: string }[]>`
        SELECT team_id, json_extract(content, '$.threadSequence') AS thread_sequence, timestamp
        FROM team_messages
        WHERE sender_type = 'system' AND timestamp >= ${since}
          AND json_extract(content, '$.type') = 'connector_undelivered'
          AND json_extract(content, '$.connectorId') = ${connectorId}
      `,
      this.db<
        {
          team_id: string;
          thread_sequence: number;
          sender_connector_id: string | null;
          content: string;
        }[]
      >`
        SELECT thread.team_id, thread.thread_sequence, root.sender_connector_id,
          substr(root.content, 1, 1000) AS content
        FROM team_connector_threads AS thread
        JOIN team_messages AS root
          ON root.team_id = thread.team_id AND root.sequence = thread.thread_sequence
        WHERE thread.connector_id = ${connectorId}
          AND EXISTS (
            SELECT 1 FROM team_messages AS message
            WHERE message.team_id = thread.team_id AND message.timestamp >= ${since}
              AND (message.sequence = thread.thread_sequence
                OR message.thread_sequence = thread.thread_sequence)
          )
      `,
    ]);
    return {
      received: received.map(passage),
      written: written.map((row) => ({ ...passage(row), content: row.content })),
      undelivered: undelivered.map(passage),
      threads: threads.map((row) => ({
        teamId: row.team_id,
        threadSequence: row.thread_sequence,
        openedBy:
          row.sender_connector_id === connectorId ? ("connector" as const) : ("team" as const),
        content: row.content,
      })),
    };
  }

  /** The thread another team holds its side of this thread's conversation in, if any. */
  async getPeerThread(
    teamId: string,
    threadSequence: number,
    peerTeamId: string,
  ): Promise<number | null> {
    const [row] = await this.db<{ peer_thread_sequence: number }[]>`
      SELECT peer_thread_sequence FROM team_peer_threads
      WHERE team_id = ${teamId} AND thread_sequence = ${threadSequence}
        AND peer_team_id = ${peerTeamId}
    `;
    return row?.peer_thread_sequence ?? null;
  }

  /** Links two teams' threads as one conversation, from either side. */
  async linkPeerThreads(
    teamId: string,
    threadSequence: number,
    peerTeamId: string,
    peerThreadSequence: number,
  ): Promise<void> {
    await this.db`
      INSERT INTO team_peer_threads (team_id, thread_sequence, peer_team_id, peer_thread_sequence)
      VALUES (${teamId}, ${threadSequence}, ${peerTeamId}, ${peerThreadSequence}),
        (${peerTeamId}, ${peerThreadSequence}, ${teamId}, ${threadSequence})
      ON CONFLICT DO NOTHING
    `;
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

  /** One actionable outage notice per sender, even when several of its messages are queued. */
  async noteConnectorUnreachable(
    teamId: string,
    content: Extract<TeamSystemMessageContent, { type: "connector_unreachable" }>,
  ) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, teamId);
      const id = `connector-unreachable:${content.connectorId}:${content.since}:${content.agentId}`;
      const [existing] = await db`SELECT id FROM team_messages WHERE id = ${id}`;
      return recordTeamChange(
        db,
        team,
        existing ? [] : [await appendSystemMessage(db, teamId, content, { id })],
      );
    });
  }

  /** One notice per silence, so a repeated report of the same stall posts nothing. */
  async noteSessionStalled(
    teamId: string,
    content: Extract<TeamSystemMessageContent, { type: "session_stalled" }>,
  ) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireTeam(db, teamId);
      const id = `session-stalled:${content.sessionId}:${content.since}`;
      const [existing] = await db`SELECT id FROM team_messages WHERE id = ${id}`;
      return recordTeamChange(
        db,
        team,
        existing ? [] : [await appendSystemMessage(db, teamId, content, { id })],
      );
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

  async listAdvice(teamId: string): Promise<TeamAdvice[]> {
    return listAdvice(this.db, teamId);
  }

  async getAdvice(teamId: string, adviceId: string): Promise<TeamAdvice | null> {
    const [row] = await this.db<TeamAdviceRow[]>`
      SELECT * FROM team_advice WHERE id = ${adviceId} AND team_id = ${teamId}
    `;
    return row ? adviceFromRow(row) : null;
  }

  /** Records an agent's advice for the user to apply or dismiss. */
  async proposeAdvice(authorId: string, input: ProposeTeamAdviceInput) {
    return inStateTransaction(this.db, async (db) => {
      const worker = await requireTeamWorker(db, authorId);
      const advice: TeamAdvice = {
        id: crypto.randomUUID(),
        ...input,
        authorId,
        status: "open",
        createdAt: new Date().toISOString(),
      };
      await db`
        INSERT INTO team_advice ${db({
          id: advice.id,
          team_id: worker.teamId,
          author_id: authorId,
          title: advice.title,
          finding: advice.finding,
          action: JSON.stringify(advice.action),
          created_at: advice.createdAt,
        })}
      `;
      return adviceChange(db, worker.teamId, advice);
    });
  }

  /**
   * Moves advice between open and resolved. Resolving claims only open advice, so concurrent
   * applies act once; reopening restores advice whose action failed.
   */
  async setAdviceStatus(teamId: string, adviceId: string, status: TeamAdvice["status"]) {
    return inStateTransaction(this.db, async (db) => {
      const [row] = await db<TeamAdviceRow[]>`
        UPDATE team_advice
        SET status = ${status},
          resolved_at = ${status === "open" ? null : new Date().toISOString()}
        WHERE id = ${adviceId} AND team_id = ${teamId}
          AND (status = 'open') = ${status !== "open"}
        RETURNING *
      `;
      return row ? adviceChange(db, teamId, adviceFromRow(row)) : null;
    });
  }

  /** Adds a routine to the lead's Team, or changes one. An identical change is a no-op. */
  async setRoutine(leadId: string, { routineId, ...input }: SetTeamRoutineInput) {
    return inStateTransaction(this.db, async (db) => {
      const team = await requireLeadTeam(db, leadId);
      const agentId = input.agentId === team.id ? undefined : input.agentId;
      if (agentId) {
        const worker = await requireTeamWorker(db, agentId);
        if (worker.teamId !== team.id) throw new Error("Routine agent must belong to this team.");
      }
      const { agentId: _agentId, ...content } = input;
      const routine = {
        id: routineId ?? crypto.randomUUID(),
        ...content,
        ...(agentId ? { agentId } : {}),
      };
      const columns = { ...content, agent_id: agentId ?? null };
      const nextAt = nextCronOccurrence(input.schedule, new Date()).toISOString();
      if (routineId) {
        const [current] = await db<TeamRoutineRow[]>`
          SELECT id, title, schedule, prompt, agent_id FROM team_routines
          WHERE id = ${routineId} AND team_id = ${team.id}
        `;
        if (!current) throw new Error("Routine not found in this team.");
        if (Bun.deepEquals(routineFromRow(current), routine)) {
          return { teamId: team.id, events: [], routine };
        }
        await db`
          UPDATE team_routines SET ${db({ ...columns, next_at: nextAt })} WHERE id = ${routineId}
        `;
      } else {
        await db`
          INSERT INTO team_routines ${db({
            id: routine.id,
            ...columns,
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
      const [row] = await db<TeamRoutineRow[]>`
        DELETE FROM team_routines WHERE id = ${routineId} AND team_id = ${teamId}
        RETURNING id, title, schedule, prompt, agent_id
      `;
      if (!row) return null;
      const team = await requireTeam(db, teamId);
      const change = await appendSystemMessage(db, teamId, {
        type: "routine_deleted",
        routine: routineFromRow(row),
      });
      return recordTeamChange(db, team, [change]);
    });
  }

  /**
   * Claims every due follow-up, routine, and task continuation, so each wakes its agent once. A
   * follow-up clears its waiting status, and a continuation its time. A routine moves past `now`,
   * so runs missed while stopped collapse into one.
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
      const routines = await db<(TeamRoutineRow & { team_id: string })[]>`
        SELECT id, team_id, title, schedule, prompt, agent_id FROM team_routines
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
      // A continuation's task kept its status and assignee, since changing either clears it.
      const continuations = await db<Pick<TeamTaskRow, "id" | "title" | "assignee_id">[]>`
        UPDATE team_tasks SET continue_at = NULL
        WHERE continue_at <= ${now.toISOString()}
          AND team_id IN (SELECT id FROM teams WHERE paused = 0)
        RETURNING id, title, assignee_id
      `;
      return {
        followUps,
        routines: routines.map(({ team_id, agent_id, title, prompt }) => ({
          teamId: team_id,
          agentId: agent_id ?? team_id,
          title,
          prompt,
        })),
        continuations: continuations.flatMap(({ id, title, assignee_id }) =>
          assignee_id ? [{ agentId: assignee_id, taskId: id, title }] : [],
        ),
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
  if (next.name !== current.name) await assertTeamNameAvailable(db, next.name, current.id);
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
  const coordinators = { ...current.connectorCoordinators, ...next.connectorCoordinators };
  for (const connectorId of Object.keys(coordinators)) {
    const agentId = next.connectorCoordinators?.[connectorId] ?? null;
    if (agentId !== (current.connectorCoordinators?.[connectorId] ?? null))
      updates.push({ type: "connector_coordinator_changed", actor, connectorId, agentId });
  }
  // User edits count as activity.
  const updatedAt = actor.type === "user" ? new Date().toISOString() : current.updatedAt;
  await db`
    UPDATE teams SET ${db({
      ...teamColumns(next),
      updated_at: updatedAt,
    })}
    WHERE id = ${current.id}
  `;
  if (!Bun.deepEquals(next.avatar, current.avatar)) {
    events.push({
      type: "avatar",
      revision: await advanceRevision(db, current.id),
      avatar: next.avatar ?? null,
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
    | "name"
    | "avatar"
    | "paused"
    | "purpose"
    | "directory"
    | "model"
    | "preview"
    | "canvasArtifactId"
    | "connectorCoordinators"
  >,
) {
  return {
    name: team.name,
    avatar: team.avatar ? JSON.stringify(team.avatar) : null,
    paused: team.paused ? 1 : 0,
    purpose: team.purpose ?? null,
    directory: team.directory ?? null,
    model: JSON.stringify(team.model),
    preview: team.preview ? JSON.stringify(team.preview) : null,
    canvas_artifact_id: team.canvasArtifactId ?? null,
    connector_coordinators: JSON.stringify(team.connectorCoordinators ?? {}),
  };
}

function appendSystemMessage(
  db: Bun.SQL,
  teamId: string,
  content: TeamSystemMessageContent,
  { id = crypto.randomUUID(), threadSequence }: { id?: string; threadSequence?: number } = {},
) {
  return appendMessage(db, teamId, (position) => ({
    ...position,
    id,
    sender: { type: "system" },
    content,
    ...(threadSequence ? { threadSequence } : {}),
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
  const attention = await involvesUser(db, teamId, message);
  if (attention) {
    await db`UPDATE teams SET attention_sequence = ${message.sequence} WHERE id = ${teamId}`;
  }
  return {
    type: "message" as const,
    message,
    revision: team.revision,
    ...(attention ? { attention: true as const } : {}),
  };
}

/**
 * Whether a message involves the user, marking the team unread: a top-level message, a question
 * for the user, the user's own message, or a reply in a thread the user posted in.
 */
async function involvesUser(db: Bun.SQL, teamId: string, message: TeamMessage) {
  if (message.threadSequence === undefined || message.request || message.sender.type === "user") {
    return true;
  }
  const [posted] = await db<{ sequence: number }[]>`
    SELECT sequence FROM team_messages
    WHERE team_id = ${teamId} AND sender_type = 'user'
      AND (sequence = ${message.threadSequence} OR thread_sequence = ${message.threadSequence})
    LIMIT 1
  `;
  return posted !== undefined;
}

function messageColumns(message: TeamMessage) {
  return {
    id: message.id,
    sequence: message.sequence,
    timestamp: message.timestamp,
    sender_type: message.sender.type,
    sender_agent_id:
      message.sender.type === "agent"
        ? message.sender.agentId
        : message.sender.type === "team" && message.sender.by === "lead"
          ? message.sender.teamId
          : null,
    sender_connector_id: message.sender.type === "connector" ? message.sender.connectorId : null,
    sender_team_id: message.sender.type === "team" ? message.sender.teamId : null,
    content:
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    attachments: message.attachments?.length ? JSON.stringify(message.attachments) : null,
    origin: !isTeamSystemMessage(message) && message.origin ? JSON.stringify(message.origin) : null,
    asked_by: message.askedBy ?? null,
    request: message.request ? 1 : 0,
    thread_sequence: message.threadSequence ?? null,
  };
}

/**
 * Replying within a thread joins it, so threads stay one level deep. A thread starts at a user or
 * agent message, or at a task's opening note; replying to the server's note in one joins it.
 */
async function resolveThreadSequence(
  db: Bun.SQL,
  teamId: string,
  sequence: number,
): Promise<number> {
  const [row] = await db<Pick<TeamMessageRow, "sender_type" | "thread_sequence" | "content">[]>`
    SELECT sender_type, thread_sequence, content FROM team_messages
    WHERE team_id = ${teamId} AND sequence = ${sequence}
  `;
  if (row?.thread_sequence) return row.thread_sequence;
  if (
    !row ||
    (row.sender_type === "system" &&
      teamSystemMessageContentSchema.parse(JSON.parse(row.content)).type !== "task_opened")
  ) {
    throw new Error("Reply to a user or agent message, or a task's thread, in this team.");
  }
  return sequence;
}

/** The task whose thread starts at this sequence, if a task's does. */
async function taskByThread(
  db: Bun.SQL,
  teamId: string,
  threadSequence: number,
): Promise<TeamTask | undefined> {
  const [row] = await db<TeamTaskRow[]>`
    SELECT * FROM team_tasks WHERE team_id = ${teamId} AND thread_sequence = ${threadSequence}
  `;
  return row && taskFromRow(row);
}

type ConversationRow = Pick<
  TeamMessageRow,
  | "sequence"
  | "sender_type"
  | "sender_agent_id"
  | "sender_connector_id"
  | "sender_team_id"
  | "content"
  | "thread_sequence"
>;

/**
 * A team's user, agent, and connector messages, newest first in bounded pages, without hydrating
 * attachments: optionally only one thread's, or only those whose text contains a literal string.
 */
async function* conversationNewestFirst(
  db: Bun.SQL,
  teamId: string,
  { thread = null, containing = null }: { thread?: number | null; containing?: string | null },
): AsyncGenerator<ConversationRow> {
  let before = Number.MAX_SAFE_INTEGER;
  for (;;) {
    const rows = await db<ConversationRow[]>`
      SELECT sequence, sender_type, sender_agent_id, sender_connector_id, sender_team_id, content,
        thread_sequence
      FROM team_messages
      WHERE team_id = ${teamId} AND sequence < ${before} AND sender_type <> 'system'
        AND (${thread} IS NULL OR sequence = ${thread} OR thread_sequence = ${thread})
        AND (${containing} IS NULL OR instr(content, ${containing}) > 0)
      ORDER BY sequence DESC
      LIMIT 100
    `;
    yield* rows;
    if (rows.length < 100) return;
    before = rows.at(-1)!.sequence;
  }
}

function messageLocation(
  row: Pick<TeamMessageRow, "sequence" | "thread_sequence">,
): TeamMessageLocation {
  return { sequence: row.sequence, threadSequence: row.thread_sequence ?? row.sequence };
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
  const rows = await db<TeamRoutineRow[]>`
    SELECT id, title, schedule, prompt, agent_id FROM team_routines
    WHERE team_id = ${teamId}
    ORDER BY created_at, id
  `;
  return rows.map(routineFromRow);
}

type TeamRoutineRow = Omit<TeamRoutine, "agentId"> & { agent_id: string | null };

function routineFromRow({ agent_id, ...routine }: TeamRoutineRow): TeamRoutine {
  return { ...routine, ...(agent_id ? { agentId: agent_id } : {}) };
}

/** How many resolved advice items a snapshot keeps beside every open one. */
const RESOLVED_ADVICE_LIMIT = 20;

async function listAdvice(db: Bun.SQL, teamId: string): Promise<TeamAdvice[]> {
  const rows = await db<TeamAdviceRow[]>`
    SELECT * FROM team_advice WHERE team_id = ${teamId} AND status = 'open'
    UNION ALL
    SELECT * FROM (
      SELECT * FROM team_advice WHERE team_id = ${teamId} AND status <> 'open'
      ORDER BY resolved_at DESC LIMIT ${RESOLVED_ADVICE_LIMIT}
    )
  `;
  return orderTeamAdvice(rows.map(adviceFromRow));
}

async function adviceChange(db: Bun.SQL, teamId: string, advice: TeamAdvice) {
  return {
    teamId,
    events: [{ type: "advice" as const, advice, revision: await advanceRevision(db, teamId) }],
    advice,
  };
}

type TeamAdviceRow = {
  id: string;
  team_id: string;
  author_id: string;
  title: string;
  finding: string;
  action: string;
  status: TeamAdvice["status"];
  created_at: string;
  resolved_at: string | null;
};

/** Where and when one message passed between a team and a connector. */
function passage(row: { team_id: string; thread_sequence: number | null; timestamp: string }) {
  return {
    teamId: row.team_id,
    ...(row.thread_sequence === null ? {} : { threadSequence: row.thread_sequence }),
    at: row.timestamp,
  };
}

function adviceFromRow(row: TeamAdviceRow): TeamAdvice {
  return {
    id: row.id,
    title: row.title,
    finding: row.finding,
    action: teamAdviceActionSchema.parse(JSON.parse(row.action)),
    authorId: row.author_id,
    status: row.status,
    createdAt: row.created_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}

type TeamRow = {
  id: string;
  name: string;
  avatar: string | null;
  purpose: string | null;
  paused: number;
  directory: string | null;
  model: string;
  last_task_number: number;
  preview: string | null;
  canvas_artifact_id: string | null;
  connector_coordinators: string;
  latest_sequence: number;
  attention_sequence: number;
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
  sender_team_id: string | null;
  content: string;
  request: number;
  attachments: string | null;
  origin: string | null;
  asked_by: string | null;
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
  const coordinators = connectorCoordinatorsSchema.parse(JSON.parse(row.connector_coordinators));
  return {
    id: row.id,
    name: row.name,
    ...(row.avatar ? { avatar: avatarSchema.parse(JSON.parse(row.avatar)) } : {}),
    paused: row.paused === 1,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(row.directory ? { directory: row.directory } : {}),
    model: modelConfigurationSchema.parse(JSON.parse(row.model)),
    ...(row.preview ? { preview: previewSchema.parse(JSON.parse(row.preview)) } : {}),
    ...(row.canvas_artifact_id ? { canvasArtifactId: row.canvas_artifact_id } : {}),
    ...(Object.keys(coordinators).length ? { connectorCoordinators: coordinators } : {}),
    latestSequence: row.latest_sequence,
    attentionSequence: row.attention_sequence,
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

/** Teams address one another by handle, so each team's must be its own. */
async function assertTeamNameAvailable(db: Bun.SQL, name: string, exceptTeamId?: string) {
  const handle = teamHandle({ name });
  if (handle === agentHandleFromName(TEAM_LEAD_PROFILE.name)) {
    throw new Error(`Every team's lead already uses the @${handle} mention.`);
  }
  const teams = await db<{ id: string; name: string }[]>`SELECT id, name FROM teams`;
  const conflict = teams.find((team) => team.id !== exceptTeamId && teamHandle(team) === handle);
  if (conflict) throw new Error(`Team ${conflict.name} already uses the @${handle} mention.`);
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
      ...(row.thread_sequence === null ? {} : { threadSequence: row.thread_sequence }),
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
    ...(row.asked_by ? { askedBy: row.asked_by } : {}),
    ...(row.request ? { request: true as const } : {}),
    ...(row.thread_sequence === null ? {} : { threadSequence: row.thread_sequence }),
    ...(attachments?.length ? { attachments } : {}),
    ...(reactions.length ? { reactions } : {}),
  };
}

function authorFromRow(
  row: Pick<
    TeamMessageRow,
    "sender_type" | "sender_agent_id" | "sender_connector_id" | "sender_team_id"
  >,
): TeamMessageAuthor {
  switch (row.sender_type) {
    case "agent":
      return { type: "agent", agentId: row.sender_agent_id! };
    case "connector":
      return { type: "connector", connectorId: row.sender_connector_id! };
    case "team":
      return {
        type: "team",
        teamId: row.sender_team_id!,
        by: row.sender_agent_id ? "lead" : "user",
      };
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

/**
 * New or changed assignees and artifacts must be current, while an unchanged stale reference
 * never blocks unrelated progress.
 */
async function assertTaskReferences(
  db: Bun.SQL,
  teamId: string,
  tasks: readonly TeamTask[],
  previousTasks: readonly TeamTask[],
): Promise<void> {
  const [agents, artifacts] = await Promise.all([
    new WorkerDatabase(db).list({ type: "team", teamId }),
    listArtifacts(db, teamId),
  ]);
  const agentIds = new Set(agents.map(({ sessionId }) => sessionId));
  const artifactIds = new Set(artifacts.map(({ id }) => id));
  const previous = new Map(previousTasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const before = previous.get(task.id);
    if (
      task.assigneeId &&
      task.assigneeId !== before?.assigneeId &&
      !agentIds.has(task.assigneeId)
    ) {
      throw new Error("Assign tasks to the team lead or a current member.");
    }
    if (
      task.artifactId &&
      task.artifactId !== before?.artifactId &&
      !artifactIds.has(task.artifactId)
    ) {
      throw new Error(`Task "${task.id}" must reference an artifact shared in this team.`);
    }
  }
}

/** A team's tasks in tree order: each parent before its subtasks, siblings in order. */
async function listTasks(db: Bun.SQL, teamId: string): Promise<TeamTask[]> {
  const rows = await db<TeamTaskRow[]>`SELECT * FROM team_tasks WHERE team_id = ${teamId}`;
  return orderTeamTasks(rows.map(taskFromRow));
}

/**
 * Applies an ordered task batch with the editor's authority. Opened tasks take the team's next
 * numbers, and each starts its thread with a typed opening note. Each note posts into its task's
 * thread, first starting one for a task that has none, and each changed or removed task publishes
 * its own event. The lead's close that completes the list appends `tasks_completed`.
 */
async function editTasks(
  db: Bun.SQL,
  teamId: string,
  worker: Extract<Worker, { type: "team" }>,
  operations: EditTeamTasksInput["operations"],
) {
  const agentId = worker.sessionId;
  const before = await listTasks(db, teamId);
  const [counter] = await db<Pick<TeamRow, "last_task_number">[]>`
    SELECT last_task_number FROM teams WHERE id = ${teamId}
  `;
  const { tasks, opened, notes, lastTaskNumber } = applyTeamTaskEdits(before, operations, {
    editor: { agentId, isLead: isTeamLead(worker) },
    now: new Date().toISOString(),
    lastTaskNumber: counter!.last_task_number,
  });
  await assertTaskReferences(db, teamId, tasks, before);
  const events: TeamEvent[] = [];
  const threaded = new Map(tasks.map((task) => [task.id, task]));
  const threadOf = async (taskId: string) => {
    const thread = await openTaskThread(db, teamId, threaded.get(taskId)!);
    events.push(...thread.events);
    threaded.set(taskId, thread.task);
    return thread.task.threadSequence;
  };
  const posted: TeamConversationMessage[] = [];
  const postNote = async ({ taskId, note }: (typeof notes)[number]) => {
    const threadSequence = await threadOf(taskId);
    const change = await appendMessage(db, teamId, (position) => ({
      ...position,
      id: crypto.randomUUID(),
      sender: { type: "agent" as const, agentId },
      content: note,
      threadSequence,
    }));
    events.push(change);
    posted.push(change.message);
  };
  // An opened task's notes follow its opening note, so they read as its first replies.
  for (const { id } of opened) {
    await threadOf(id);
    for (const note of notes.filter(({ taskId }) => taskId === id)) await postNote(note);
  }
  for (const note of notes.filter(({ taskId }) => !opened.some(({ id }) => id === taskId))) {
    await postNote(note);
  }
  const after = [...threaded.values()];
  events.push(...(await saveTasks(db, teamId, before, after)));
  if (lastTaskNumber !== counter!.last_task_number) {
    await db`UPDATE teams SET last_task_number = ${lastTaskNumber} WHERE id = ${teamId}`;
  }
  if (!teamTasksComplete(before) && teamTasksComplete(after)) {
    events.push(await appendSystemMessage(db, teamId, { type: "tasks_completed" }));
  }
  return {
    events,
    opened: opened.map(({ id }) => threaded.get(id)!),
    before,
    after,
    notes: posted,
  };
}

/** Starts a task's thread with its opening note when it has none yet; the caller saves the task. */
async function openTaskThread(db: Bun.SQL, teamId: string, task: TeamTask) {
  if (task.threadSequence) {
    return { task: { ...task, threadSequence: task.threadSequence }, events: [] };
  }
  const root = await appendSystemMessage(db, teamId, {
    type: "task_opened",
    taskId: task.id,
    title: task.title,
    actor: task.openedBy,
  });
  return { task: { ...task, threadSequence: root.message.sequence }, events: [root] };
}

/**
 * A report continues its task only while fewer than the limit of reports in a row already have.
 * A report that changes the task's status starts a new run.
 */
async function assertContinuations(
  db: Bun.SQL,
  teamId: string,
  tasks: readonly TeamTask[],
  reports: readonly TeamTaskReport[],
) {
  for (const { taskId, status, continueAfterMinutes } of reports) {
    if (continueAfterMinutes === undefined) continue;
    if (tasks.find(({ id }) => id === taskId)?.status !== status) continue;
    const [row] = await db<Pick<TeamTaskRow, "continues">[]>`
      SELECT continues FROM team_tasks WHERE team_id = ${teamId} AND id = ${taskId}
    `;
    if (row && row.continues >= TEAM_TASK_CONTINUE_LIMIT) {
      throw new Error(
        `${taskId} has continued ${row.continues} times in a row. Report it blocked with what it waits for, or in_review if your part is done, and mention the lead in its thread if it needs a decision.`,
      );
    }
  }
}

/** Changes an agent's status or turn tasks, publishing an event for each that changed. */
async function changeAgentActivity(
  db: Bun.SQL,
  worker: Extract<Worker, { type: "team" }>,
  changes: { status?: TeamAgentStatus | null; turnTasks?: string[] | null },
): Promise<TeamEvent[]> {
  const agentId = worker.sessionId;
  const metadata = teamAgentMetadataSchema.parse(worker.metadata);
  const next = applyPatch(metadata, changes);
  const events: TeamEvent[] = [];
  if (!Bun.deepEquals(metadata.status, next.status)) {
    const revision = await advanceRevision(db, worker.teamId);
    events.push({ type: "status", agentId, status: next.status, revision });
  }
  if (!Bun.deepEquals(metadata.turnTasks, next.turnTasks)) {
    const revision = await advanceRevision(db, worker.teamId);
    events.push({ type: "turn", agentId, turnTasks: next.turnTasks, revision });
  }
  if (events.length) await new WorkerDatabase(db).update(agentId, { metadata: next });
  return events;
}

/** Persists the difference between two task lists, publishing one event per task it changes. */
async function saveTasks(
  db: Bun.SQL,
  teamId: string,
  before: readonly TeamTask[],
  after: readonly TeamTask[],
): Promise<TeamEvent[]> {
  const previous = new Map(before.map((task) => [task.id, task]));
  const kept = new Set(after.map(({ id }) => id));
  const events: TeamEvent[] = [];
  // Parents first, so each subtask's parent exists when the subtask is written.
  for (const task of orderTeamTasks(after)) {
    const current = previous.get(task.id);
    if (Bun.deepEquals(current, task)) continue;
    if (current) {
      // A new status or assignee is a new situation: any continuation and its counts start over.
      const restarts = current.status !== task.status || current.assigneeId !== task.assigneeId;
      await db`
        UPDATE team_tasks
        SET ${db({ ...taskColumns(task), ...(restarts ? RESTARTED_TURNS : {}) })}
        WHERE team_id = ${teamId} AND id = ${task.id}
      `;
    } else {
      await db`
        INSERT INTO team_tasks ${db({ team_id: teamId, id: task.id, ...taskColumns(task) })}
      `;
    }
    events.push({ type: "task", task, revision: await advanceRevision(db, teamId) });
  }
  // Subtasks first, so no client ever holds a subtask whose parent is gone.
  for (const { id } of orderTeamTasks(before).reverse()) {
    if (kept.has(id)) continue;
    await db`DELETE FROM team_tasks WHERE team_id = ${teamId} AND id = ${id}`;
    events.push({ type: "task_removed", taskId: id, revision: await advanceRevision(db, teamId) });
  }
  return events;
}

/** A member leaving the team releases every task assigned to it. */
async function releaseTasks(
  db: Bun.SQL,
  teamId: string,
  agentIds: readonly string[],
): Promise<TeamEvent[]> {
  const updatedAt = new Date().toISOString();
  const events: TeamEvent[] = [];
  for (const agentId of agentIds) {
    const rows = await db<TeamTaskRow[]>`
      UPDATE team_tasks
      SET assignee_id = NULL, updated_at = ${updatedAt},
        continue_at = NULL, continues = 0, unreported_turns = 0
      WHERE team_id = ${teamId} AND assignee_id = ${agentId}
      RETURNING *
    `;
    for (const task of orderTeamTasks(rows.map(taskFromRow))) {
      events.push({ type: "task", task, revision: await advanceRevision(db, teamId) });
    }
  }
  return events;
}

/** A task's turn bookkeeping, reset when its status or assignee changes. */
const RESTARTED_TURNS = { continue_at: null, continues: 0, unreported_turns: 0 };

function taskColumns(task: TeamTask) {
  return {
    parent_id: task.parentId ?? null,
    position: task.position,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    priority: task.priority,
    assignee_id: task.assigneeId ?? null,
    opened_by: task.openedBy.type === "agent" ? task.openedBy.agentId : null,
    artifact_id: task.artifactId ?? null,
    diff: task.diff ? JSON.stringify(task.diff) : null,
    thread_sequence: task.threadSequence ?? null,
    opened_at: task.openedAt,
    updated_at: task.updatedAt,
    closed_at: task.closedAt ?? null,
  };
}

function taskFromRow(row: TeamTaskRow): TeamTask {
  return {
    id: row.id,
    ...(row.parent_id === null ? {} : { parentId: row.parent_id }),
    position: row.position,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    status: teamTaskStatusSchema.parse(row.status),
    priority: teamTaskPrioritySchema.parse(row.priority),
    ...(row.assignee_id === null ? {} : { assigneeId: row.assignee_id }),
    openedBy: row.opened_by === null ? { type: "user" } : { type: "agent", agentId: row.opened_by },
    ...(row.artifact_id === null ? {} : { artifactId: row.artifact_id }),
    ...(row.diff === null ? {} : { diff: diffStatsSchema.parse(JSON.parse(row.diff)) }),
    ...(row.thread_sequence === null ? {} : { threadSequence: row.thread_sequence }),
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    ...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
  };
}

type TeamTaskRow = {
  id: string;
  parent_id: string | null;
  position: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_id: string | null;
  opened_by: string | null;
  artifact_id: string | null;
  diff: string | null;
  thread_sequence: number | null;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  continue_at: string | null;
  continues: number;
  unreported_turns: number;
};
