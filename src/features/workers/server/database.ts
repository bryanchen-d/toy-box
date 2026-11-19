// Persisted ownership and lifetime policy for worker sessions.

import { sessionFile } from "@files/model";
import { getStateDatabase, inStateTransaction } from "@/server/database";
import { smallJsonSchema } from "@/shared/smallJson";
import type { Worker, WorkerOwner } from "../model";
import type { SubSessionRecord } from "../model/subSessions";

/** Construct a reserved identity without starting a Session or publishing active work. */
export function createWorker<
  Input extends WorkerOwner & Pick<Worker, "ephemeral" | "name"> & { metadata?: unknown },
>(input: Input, sessionId: string = crypto.randomUUID()) {
  return {
    ...input,
    metadata: input.metadata === undefined ? undefined : smallJsonSchema.parse(input.metadata),
    sessionId,
    createdAt: new Date().toISOString(),
  };
}

/** Worker persistence that owners can compose into their own transactions. */
export class WorkerDatabase {
  constructor(private readonly db: Bun.SQL) {}

  async get<Type extends Worker["type"] = Worker["type"]>(
    sessionId: string,
    scope?: Type | Extract<WorkerOwner, { type: Type }>,
  ): Promise<Extract<Worker, { type: Type }> | null> {
    const owner = scope ? this.db`AND ${scopePredicate(this.db, scope)}` : this.db``;
    const [row] = await this.db<WorkerRow[]>`
      SELECT * FROM workers WHERE session_id = ${sessionId} ${owner}
    `;
    return row ? (workerFromRow(row) as Extract<Worker, { type: Type }>) : null;
  }

  async list<Type extends Worker["type"]>(
    scope: Type | Extract<WorkerOwner, { type: Type }>,
  ): Promise<Extract<Worker, { type: Type }>[]> {
    const owner = scopePredicate(this.db, scope);
    const rows = await this.db<WorkerRow[]>`
      SELECT * FROM workers WHERE ${owner}
      ORDER BY created_at DESC, session_id
    `;
    return rows.map((row) => workerFromRow(row) as Extract<Worker, { type: Type }>);
  }

  /** Construction validates metadata before admission can publish or persist the Worker. */
  async create(worker: Worker): Promise<void> {
    const row = {
      session_id: worker.sessionId,
      created_at: Date.parse(worker.createdAt),
      worker_type: worker.type,
      ...workerColumns(worker),
      ephemeral: worker.ephemeral ? 1 : 0,
      name: worker.name,
      metadata: worker.metadata === undefined ? null : JSON.stringify(worker.metadata),
    };
    await this.db`INSERT INTO workers ${this.db(row)}`;
  }

  async update(
    sessionId: string,
    details: Pick<Worker, "name"> & { metadata?: unknown },
  ): Promise<boolean> {
    const fields = {
      name: details.name,
      metadata: Object.hasOwn(details, "metadata")
        ? serializeWorkerMetadata(details.metadata)
        : undefined,
    };
    const rows = await this.db<{ session_id: string }[]>`
      UPDATE workers SET ${this.db(fields)} WHERE session_id = ${sessionId}
      RETURNING session_id
    `;
    return rows.length > 0;
  }

  async delete(sessionId: string): Promise<boolean> {
    const rows = await this.db<{ session_id: string }[]>`
      DELETE FROM workers WHERE session_id = ${sessionId} RETURNING session_id
    `;
    if (rows.length === 0) return false;
    // However a sub session ends, its Worker goes, so this is where its history closes.
    await this.db`
      UPDATE sub_session_history SET closed_at = ${Date.now()}
      WHERE session_id = ${sessionId} AND closed_at IS NULL
    `;
    return true;
  }

  /** Moves a team Worker to another team; its Session and history stay with it. */
  async moveToTeam(sessionId: string, teamId: string): Promise<boolean> {
    const rows = await this.db<{ session_id: string }[]>`
      UPDATE workers SET team_id = ${teamId}
      WHERE session_id = ${sessionId} AND worker_type = 'team'
      RETURNING session_id
    `;
    return rows.length > 0;
  }

  /** Initialize absent metadata without replacing a result or recreating deleted ownership. */
  async initializeMetadata(
    sessionId: string,
    type: Worker["type"],
    metadata: unknown,
  ): Promise<boolean> {
    const rows = await this.db<WorkerSessionIdRow[]>`
      UPDATE workers
      SET metadata = ${serializeWorkerMetadata(metadata)}
      WHERE session_id = ${sessionId} AND worker_type = ${type} AND metadata IS NULL
      RETURNING session_id
    `;
    return rows.length > 0;
  }
}

export async function getWorkerSessionIdsForParent(parentSessionId: string): Promise<string[]> {
  const db = await getStateDatabase({ createIfMissing: false });
  if (!db) return [];
  const rows = await db<WorkerSessionIdRow[]>`
    SELECT session_id FROM workers
    WHERE parent_session_id = ${parentSessionId}
    ORDER BY session_id
  `;
  return rows.map((row) => row.session_id);
}

export async function getWorkerSessionIdsForApp(appId: string): Promise<string[]> {
  const db = await getStateDatabase({ createIfMissing: false });
  if (!db) return [];
  const rows = await db<WorkerSessionIdRow[]>`
    SELECT session_id FROM workers WHERE app_id = ${appId} ORDER BY session_id
  `;
  return rows.map((row) => row.session_id);
}

/** Ephemeral workers cannot outlive their process-local supervisor. */
export async function getEphemeralWorkerSessionIds(): Promise<string[]> {
  const db = await getStateDatabase({ createIfMissing: false });
  if (!db) return [];
  const rows = await db<WorkerSessionIdRow[]>`
    SELECT session_id FROM workers WHERE ephemeral = 1 ORDER BY session_id
  `;
  return rows.map((row) => row.session_id);
}

export async function getPersistedWorker(sessionId: string): Promise<Worker | null> {
  const db = await getStateDatabase({ createIfMissing: false });
  return db ? new WorkerDatabase(db).get(sessionId) : null;
}

export async function registerWorkerSession(worker: Worker): Promise<void> {
  await new WorkerDatabase(await getStateDatabase()).create(worker);
}

export async function unregisterWorkerSession(sessionId: string): Promise<boolean> {
  const db = await getStateDatabase({ createIfMissing: false });
  return db ? new WorkerDatabase(db).delete(sessionId) : false;
}

/** Persists a sub session's Worker together with the history that outlives it. */
export async function admitSubSession(
  worker: Extract<Worker, { type: "session" }>,
  placement: { teamId?: string; node?: string },
): Promise<void> {
  await inStateTransaction(await getStateDatabase(), async (db) => {
    await new WorkerDatabase(db).create(worker);
    await db`
      INSERT INTO sub_session_history ${db({
        session_id: worker.sessionId,
        owner_session_id: worker.parentSessionId,
        team_id: placement.teamId ?? null,
        node: placement.node ?? null,
        name: worker.name ?? null,
        created_at: Date.parse(worker.createdAt),
      })}
    `;
  });
}

/** The sub sessions created or closed since `since`, newest first. */
export async function readSubSessionHistory(since: Date): Promise<SubSessionRecord[]> {
  const db = await getStateDatabase({ createIfMissing: false });
  if (!db) return [];
  const rows = await db<SubSessionHistoryRow[]>`
    SELECT * FROM sub_session_history
    WHERE created_at >= ${since.getTime()} OR closed_at >= ${since.getTime()}
    ORDER BY created_at DESC, session_id
  `;
  return rows.map((row) => ({
    sessionId: row.session_id,
    ownerSessionId: row.owner_session_id,
    ...(row.team_id ? { teamId: row.team_id } : {}),
    ...(row.node ? { node: row.node } : {}),
    ...(row.name ? { name: row.name } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    ...(row.closed_at === null ? {} : { closedAt: new Date(row.closed_at).toISOString() }),
  }));
}

type SubSessionHistoryRow = {
  session_id: string;
  owner_session_id: string;
  team_id: string | null;
  node: string | null;
  name: string | null;
  created_at: number;
  closed_at: number | null;
};

function workerColumns(worker: WorkerOwner) {
  switch (worker.type) {
    case "session":
      return { parent_session_id: worker.parentSessionId };
    case "file":
      return { parent_session_id: worker.file.sessionId, file_path: worker.file.path };
    case "app":
      return { app_id: worker.appId };
    case "team":
      return { team_id: worker.teamId };
    case "inbox":
      return {};
  }
}

function scopePredicate(db: Bun.SQL, scope: Worker["type"] | WorkerOwner) {
  const type = typeof scope === "string" ? scope : scope.type;
  const owner = typeof scope === "string" ? db`` : ownerPredicate(db, scope);
  return db`worker_type = ${type} ${owner}`;
}

function ownerPredicate(db: Bun.SQL, owner: WorkerOwner) {
  switch (owner.type) {
    case "session":
      return db`AND parent_session_id = ${owner.parentSessionId}`;
    case "file":
      return db`AND parent_session_id = ${owner.file.sessionId} AND file_path = ${owner.file.path}`;
    case "app":
      return db`AND app_id = ${owner.appId}`;
    case "team":
      return db`AND team_id = ${owner.teamId}`;
    case "inbox":
      return db``;
  }
}

function serializeWorkerMetadata(metadata: unknown): string | null {
  return metadata === undefined ? null : JSON.stringify(smallJsonSchema.parse(metadata));
}

function workerFromRow(row: WorkerRow): Worker {
  // SQLite enforces valid JSON. Write limits must not prevent reading or deleting old records.
  const metadata: Worker["metadata"] = row.metadata === null ? undefined : JSON.parse(row.metadata);
  const common = {
    sessionId: row.session_id,
    createdAt: new Date(row.created_at).toISOString(),
    ephemeral: row.ephemeral === 1,
    ...(row.name ? { name: row.name } : {}),
    ...(metadata === undefined ? {} : { metadata }),
  };
  switch (row.worker_type) {
    case "session":
      return { ...common, type: "session", parentSessionId: row.parent_session_id! };
    case "file":
      return {
        ...common,
        type: "file",
        file: sessionFile(row.parent_session_id!, row.file_path!),
      };
    case "app":
      return { ...common, type: "app", appId: row.app_id! };
    case "team":
      return { ...common, type: "team", teamId: row.team_id! };
    case "inbox":
      return { ...common, type: "inbox", ephemeral: false };
  }
}

type WorkerRow = {
  session_id: string;
  created_at: number;
  worker_type: Worker["type"];
  parent_session_id: string | null;
  file_path: string | null;
  app_id: string | null;
  team_id: string | null;
  ephemeral: number;
  name: string | null;
  metadata: string | null;
};

type WorkerSessionIdRow = { session_id: string };
