import {
  connectorHandle,
  connectorTransportSchema,
  type Connector,
  type ConnectorMessage,
  type ConnectorOptions,
} from "../model";

/** A connector with the server-private state its link needs. */
export type ConnectorRecord = Connector & { clientId: string; receivedThrough: number };

/** One message waiting at the head of its conversation's delivery queue. */
export type PendingConnectorMessage = {
  id: string;
  connectorId: string;
  message: ConnectorMessage;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
};

export class ConnectorNameTakenError extends Error {
  constructor(name: string) {
    super(`A connector named ${name} already exists.`);
  }
}

export class ConnectorDatabase {
  constructor(private readonly db: Bun.SQL) {}

  async list(): Promise<ConnectorRecord[]> {
    const rows = await this.db<ConnectorRow[]>`
      SELECT * FROM connectors ORDER BY name COLLATE NOCASE, id
    `;
    return rows.map(recordFromRow);
  }

  async get(connectorId: string): Promise<ConnectorRecord | null> {
    const [row] = await this.db<ConnectorRow[]>`
      SELECT * FROM connectors WHERE id = ${connectorId}
    `;
    return row ? recordFromRow(row) : null;
  }

  async create(options: ConnectorOptions): Promise<ConnectorRecord> {
    const now = new Date().toISOString();
    const row: ConnectorRow = {
      id: crypto.randomUUID(),
      name: options.name,
      handle: connectorHandle(options),
      transport: JSON.stringify(options.transport),
      client_id: crypto.randomUUID(),
      received_through: 0,
      created_at: now,
      updated_at: now,
    };
    await withUniqueName(options.name, () => this.db`INSERT INTO connectors ${this.db(row)}`);
    return recordFromRow(row);
  }

  async update(connectorId: string, options: ConnectorOptions): Promise<ConnectorRecord | null> {
    const [row] = await withUniqueName(
      options.name,
      () => this.db<ConnectorRow[]>`
        UPDATE connectors
        SET name = ${options.name}, handle = ${connectorHandle(options)},
            transport = ${JSON.stringify(options.transport)}, updated_at = ${new Date().toISOString()}
        WHERE id = ${connectorId}
        RETURNING *
      `,
    );
    return row ? recordFromRow(row) : null;
  }

  async delete(connectorId: string): Promise<boolean> {
    const rows = await this.db<{ id: string }[]>`
      DELETE FROM connectors WHERE id = ${connectorId} RETURNING id
    `;
    return rows.length > 0;
  }

  /** Records that every event through `sequence` was applied. The cursor never moves back. */
  async advanceReceivedThrough(connectorId: string, sequence: number): Promise<void> {
    await this.db`
      UPDATE connectors SET received_through = MAX(received_through, ${sequence})
      WHERE id = ${connectorId}
    `;
  }

  async enqueue(connectorId: string, message: ConnectorMessage, now = new Date()): Promise<void> {
    const createdAt = now.toISOString();
    await this.db`
      INSERT INTO connector_outbox (id, connector_id, conversation_id, message, created_at, next_attempt_at)
      VALUES (${message.id}, ${connectorId}, ${message.conversationId}, ${JSON.stringify(message)}, ${createdAt}, ${createdAt})
      ON CONFLICT(connector_id, id) DO NOTHING
    `;
  }

  /** The oldest undelivered message of each conversation, when its retry is due. */
  async dueMessages(connectorId: string, now = new Date()): Promise<PendingConnectorMessage[]> {
    const rows = await this.db<OutboxRow[]>`
      SELECT * FROM connector_outbox AS pending
      WHERE connector_id = ${connectorId}
        AND next_attempt_at <= ${now.toISOString()}
        AND NOT EXISTS (
          SELECT 1 FROM connector_outbox AS earlier
          WHERE earlier.connector_id = pending.connector_id
            AND earlier.conversation_id = pending.conversation_id
            AND earlier.position < pending.position
        )
      ORDER BY position
    `;
    return rows.map(pendingFromRow);
  }

  /** When the next conversation head becomes due, or null when nothing is queued. */
  async nextAttemptAt(connectorId: string): Promise<string | null> {
    const [row] = await this.db<{ next_attempt_at: string | null }[]>`
      SELECT MIN(next_attempt_at) AS next_attempt_at FROM connector_outbox AS pending
      WHERE connector_id = ${connectorId}
        AND NOT EXISTS (
          SELECT 1 FROM connector_outbox AS earlier
          WHERE earlier.connector_id = pending.connector_id
            AND earlier.conversation_id = pending.conversation_id
            AND earlier.position < pending.position
        )
    `;
    return row?.next_attempt_at ?? null;
  }

  async countPending(connectorId: string): Promise<number> {
    const [row] = await this.db<{ count: number }[]>`
      SELECT COUNT(*) AS count FROM connector_outbox WHERE connector_id = ${connectorId}
    `;
    return row?.count ?? 0;
  }

  async recordFailure(
    connectorId: string,
    id: string,
    error: string,
    nextAttemptAt: Date,
  ): Promise<void> {
    await this.db`
      UPDATE connector_outbox
      SET attempts = attempts + 1, last_error = ${error}, next_attempt_at = ${nextAttemptAt.toISOString()}
      WHERE connector_id = ${connectorId} AND id = ${id}
    `;
  }

  /** Removes a delivered, rejected, or expired message. */
  async remove(connectorId: string, id: string): Promise<void> {
    await this.db`DELETE FROM connector_outbox WHERE connector_id = ${connectorId} AND id = ${id}`;
  }

  /** Removes and returns every message created before `cutoff`. */
  async takeExpired(connectorId: string, cutoff: Date): Promise<PendingConnectorMessage[]> {
    const rows = await this.db<OutboxRow[]>`
      DELETE FROM connector_outbox
      WHERE connector_id = ${connectorId} AND created_at <= ${cutoff.toISOString()}
      RETURNING *
    `;
    return rows
      .map(pendingFromRow)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}

type ConnectorRow = {
  id: string;
  name: string;
  handle: string;
  transport: string;
  client_id: string;
  received_through: number;
  created_at: string;
  updated_at: string;
};

type OutboxRow = {
  position: number;
  id: string;
  connector_id: string;
  conversation_id: string;
  message: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
};

function recordFromRow(row: ConnectorRow): ConnectorRecord {
  return {
    id: row.id,
    name: row.name,
    transport: connectorTransportSchema.parse(JSON.parse(row.transport)),
    clientId: row.client_id,
    receivedThrough: row.received_through,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pendingFromRow(row: OutboxRow): PendingConnectorMessage {
  return {
    id: row.id,
    connectorId: row.connector_id,
    message: JSON.parse(row.message) as ConnectorMessage,
    createdAt: row.created_at,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

async function withUniqueName<Result>(name: string, write: () => Promise<Result>): Promise<Result> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE")
      throw new ConnectorNameTakenError(name);
    throw error;
  }
}
