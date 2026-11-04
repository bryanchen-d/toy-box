import { getStateDatabase, inStateTransaction } from "@/server/database";

export class SessionArtifactPinsDatabase {
  constructor(private readonly db: Bun.SQL) {}

  async list(sessionId: string): Promise<string[]> {
    const rows = await this.db<{ path: string }[]>`
      SELECT path FROM session_artifact_pins WHERE session_id = ${sessionId} ORDER BY position
    `;
    return rows.map(({ path }) => path);
  }

  async set(sessionId: string, path: string, pinned: boolean): Promise<void> {
    await inStateTransaction(this.db, async (db) => {
      if (pinned) {
        await db`
          INSERT INTO session_artifact_pins (session_id, path, position)
          VALUES (${sessionId}, ${path}, (
            SELECT COALESCE(MAX(position), -1) + 1 FROM session_artifact_pins
            WHERE session_id = ${sessionId}
          ))
          ON CONFLICT(session_id, path) DO NOTHING
        `;
      } else {
        await db`DELETE FROM session_artifact_pins WHERE session_id = ${sessionId} AND path = ${path}`;
      }
    });
  }
}

export async function readSessionArtifactPins(sessionId: string): Promise<string[]> {
  const db = await getStateDatabase({ createIfMissing: false });
  return db ? new SessionArtifactPinsDatabase(db).list(sessionId) : [];
}
