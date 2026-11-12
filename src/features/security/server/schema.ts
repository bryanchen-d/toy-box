/** Install the current tables whose meaning is owned by Security. */
export async function initializeSecuritySchema(db: Bun.SQL): Promise<void> {
  await db.unsafe(`
    -- Untrusted content judged to be an injection attempt, kept after its session is gone.
    -- An open finding holds its session's risky actions.
    CREATE TABLE IF NOT EXISTS security_findings (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      source        TEXT NOT NULL,
      action        TEXT NOT NULL,
      -- The passage that does it, and why the judge considered it risky.
      quote         TEXT NOT NULL,
      reason        TEXT NOT NULL,
      excerpt       TEXT NOT NULL,
      -- Rereading the same content in a session records it once.
      content_hash  TEXT NOT NULL,
      detected_at   TEXT NOT NULL,
      -- Closing records whether the user found it was really an attack; reopening clears both.
      closed_at     TEXT,
      outcome       TEXT CHECK (outcome IN ('false-positive', 'attack')),
      UNIQUE(session_id, content_hash),
      CHECK ((closed_at IS NULL) = (outcome IS NULL))
    );
  `);
}
