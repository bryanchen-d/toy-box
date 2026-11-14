/** Install the current tables whose meaning is owned by Connectors. */
export async function initializeConnectorSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS connectors (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL,
      -- The @handle derived from the name; two connectors can't share one.
      handle            TEXT NOT NULL UNIQUE,
      -- What the connector is: { kind: "service", transport } or { kind: "agentPool", nodes }.
      definition        TEXT NOT NULL CHECK (json_valid(definition)),
      -- Identifies this installation to the connector, which routes its outbox by it.
      client_id         TEXT NOT NULL,
      -- The last connector event applied; the stream resumes after it.
      received_through  INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(received_through) = 'integer' AND received_through >= 0),
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL
    );

    -- Messages waiting to be delivered to a connector, in order per conversation.
    CREATE TABLE IF NOT EXISTS connector_outbox (
      position          INTEGER PRIMARY KEY AUTOINCREMENT,
      id                TEXT NOT NULL,
      connector_id      TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
      conversation_id   TEXT NOT NULL,
      message           TEXT NOT NULL CHECK (json_valid(message)),
      created_at        TEXT NOT NULL,
      attempts          INTEGER NOT NULL DEFAULT 0
        CHECK (typeof(attempts) = 'integer' AND attempts >= 0),
      next_attempt_at   TEXT NOT NULL,
      last_error        TEXT,
      UNIQUE(connector_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_connector_outbox_conversation
      ON connector_outbox(connector_id, conversation_id, position);
  `);
}
