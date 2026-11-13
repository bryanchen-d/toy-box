/** Install the current tables whose meaning is owned by Sessions. */
export async function initializeSessionSchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      provider_id TEXT,
      native_id TEXT,
      created_at INTEGER NOT NULL,
      artifact_path TEXT,
      CHECK (provider_id IS NOT NULL OR native_id IS NULL)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS session_native_identity
      ON sessions (provider_id, COALESCE(native_id, session_id));

    CREATE TABLE IF NOT EXISTS worktrees (
      session_id           TEXT PRIMARY KEY,
      worktree_path        TEXT NOT NULL,
      worktree_branch      TEXT NOT NULL,
      worktree_base_branch TEXT NOT NULL,
      lines_added          INTEGER,
      lines_removed        INTEGER
    );

    CREATE TABLE IF NOT EXISTS session_artifact_pins (
      session_id TEXT NOT NULL,
      path       TEXT NOT NULL,
      position   INTEGER NOT NULL,
      PRIMARY KEY (session_id, path)
    );

    -- hour is the epoch milliseconds of a UTC hour's start. Rows outlive their session.
    CREATE TABLE IF NOT EXISTS session_activity_hours (
      session_id         TEXT NOT NULL,
      hour               INTEGER NOT NULL,
      turns              INTEGER NOT NULL DEFAULT 0,
      busy_ms            INTEGER NOT NULL DEFAULT 0,
      ai_credits         REAL NOT NULL DEFAULT 0,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, hour)
    );
  `);
}
