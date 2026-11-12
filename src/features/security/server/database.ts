import type { ClosedFindingsQuery, FindingOutcome, SecurityFinding } from "../model";

type FindingRow = {
  id: string;
  session_id: string;
  source: string;
  action: string;
  quote: string;
  reason: string;
  excerpt: string;
  content_hash: string;
  detected_at: string;
  closed_at: string | null;
  outcome: FindingOutcome | null;
};

export class SecurityDatabase {
  constructor(private readonly db: Bun.SQL) {}

  async listOpenFindings(): Promise<SecurityFinding[]> {
    const rows = await this.db<FindingRow[]>`
      SELECT * FROM security_findings WHERE closed_at IS NULL ORDER BY detected_at DESC, id
    `;
    return rows.map(findingFromRow);
  }

  /** Closed findings, most recently closed first, before a cursor and in some sessions. */
  async listClosedFindings(
    { sessionIds, before }: ClosedFindingsQuery,
    limit: number,
  ): Promise<SecurityFinding[]> {
    const sessions = sessionIds
      ? this.db`AND session_id IN (SELECT value FROM json_each(${JSON.stringify(sessionIds)}))`
      : this.db``;
    const older = before
      ? this
          .db`AND (closed_at < ${before.closedAt} OR (closed_at = ${before.closedAt} AND id < ${before.id}))`
      : this.db``;
    const rows = await this.db<FindingRow[]>`
      SELECT * FROM security_findings
      WHERE closed_at IS NOT NULL ${sessions} ${older}
      ORDER BY closed_at DESC, id DESC
      LIMIT ${limit}
    `;
    return rows.map(findingFromRow);
  }

  /** Record a finding, or return undefined when the session already recorded this content. */
  async addFinding(
    finding: Omit<SecurityFinding, "id" | "detectedAt" | "closed">,
    contentHash: string,
  ): Promise<SecurityFinding | undefined> {
    const row: FindingRow = {
      id: crypto.randomUUID(),
      session_id: finding.sessionId,
      source: finding.source,
      action: finding.action,
      quote: finding.quote,
      reason: finding.reason,
      excerpt: finding.excerpt,
      content_hash: contentHash,
      detected_at: new Date().toISOString(),
      closed_at: null,
      outcome: null,
    };
    const inserted = await this.db<FindingRow[]>`
      INSERT INTO security_findings ${this.db(row)}
      ON CONFLICT(session_id, content_hash) DO NOTHING
      RETURNING *
    `;
    return inserted[0] ? findingFromRow(inserted[0]) : undefined;
  }

  async getFinding(findingId: string): Promise<SecurityFinding | undefined> {
    const [row] = await this.db<
      FindingRow[]
    >`SELECT * FROM security_findings WHERE id = ${findingId}`;
    return row ? findingFromRow(row) : undefined;
  }

  /** Close a finding, or correct a closed one's outcome without moving it in the closed list. */
  async closeFinding(
    findingId: string,
    outcome: FindingOutcome,
  ): Promise<SecurityFinding | undefined> {
    const [row] = await this.db<FindingRow[]>`
      UPDATE security_findings
      SET closed_at = COALESCE(closed_at, ${new Date().toISOString()}), outcome = ${outcome}
      WHERE id = ${findingId}
      RETURNING *
    `;
    return row ? findingFromRow(row) : undefined;
  }

  async reopenFinding(findingId: string): Promise<SecurityFinding | undefined> {
    const [row] = await this.db<FindingRow[]>`
      UPDATE security_findings SET closed_at = NULL, outcome = NULL
      WHERE id = ${findingId}
      RETURNING *
    `;
    return row ? findingFromRow(row) : undefined;
  }

  /** The newest open finding in a session. */
  async findOpenFinding(sessionId: string): Promise<SecurityFinding | undefined> {
    const [row] = await this.db<FindingRow[]>`
      SELECT * FROM security_findings
      WHERE session_id = ${sessionId} AND closed_at IS NULL
      ORDER BY detected_at DESC
      LIMIT 1
    `;
    return row ? findingFromRow(row) : undefined;
  }
}

function findingFromRow(row: FindingRow): SecurityFinding {
  return {
    id: row.id,
    sessionId: row.session_id,
    source: row.source,
    action: row.action,
    quote: row.quote,
    reason: row.reason,
    excerpt: row.excerpt,
    detectedAt: row.detected_at,
    ...(row.closed_at && row.outcome
      ? { closed: { outcome: row.outcome, at: row.closed_at } }
      : {}),
  };
}
