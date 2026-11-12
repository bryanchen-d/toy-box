// Security's server capabilities: receiving untrusted content into a session, screening it, and
// keeping the record of attacks that holds a session's risky actions until the user closes it.

import { createHash } from "node:crypto";
import { getStateDatabase } from "@/server/database";
import { broadcast } from "@workspace/server/events";
import type {
  ClosedFindingsPage,
  ClosedFindingsQuery,
  FindingExchange,
  FindingOutcome,
  Screening,
  SecurityFinding,
  UntrustedContent,
} from "../model";
import { wrapUntrustedContent } from "../model/envelope";
import { SecurityDatabase } from "./database";
import { explainFinding, screenContent } from "./judge";

/** Findings keep this much of the flagged content, for context around the quote. */
const EXCERPT_LENGTH = 2_000;
const QUOTE_LENGTH = 300;
const CLOSED_PAGE_SIZE = 20;

/**
 * Receive content from someone other than the owner into a session: screen it, record it when
 * it's an attack, and return the envelope the agent should read.
 */
export async function receiveUntrustedContent(
  sessionId: string,
  content: UntrustedContent,
): Promise<string> {
  const screening = await screenContent(content.text);
  await recordScreening(sessionId, content, screening);
  return wrapUntrustedContent(content, screening);
}

/** Record a session's screened content when the judge found an attack in it. */
export async function recordScreening(
  sessionId: string,
  content: UntrustedContent,
  screening: Screening | undefined,
): Promise<void> {
  if (!screening?.attack) return;
  const finding = await new SecurityDatabase(await getStateDatabase()).addFinding(
    {
      sessionId,
      source: content.source,
      action: screening.action,
      quote: quotedPassage(content.text, screening.quote),
      reason: screening.reason,
      excerpt: content.text.slice(0, EXCERPT_LENGTH),
    },
    createHash("sha256").update(content.text).digest("hex"),
  );
  if (!finding) return;
  console.warn(
    `Flagged a likely prompt injection in session ${sessionId} from ${content.source}: ${screening.action}`,
  );
  broadcast({ type: "security.finding.upserted", finding });
}

/** Answer the owner's question about a finding, following up on their earlier ones. */
export async function explainSecurityFinding(
  findingId: string,
  question: string,
  earlier: readonly FindingExchange[],
): Promise<string> {
  const finding = await new SecurityDatabase(await getStateDatabase()).getFinding(findingId);
  if (!finding) throw new Error("Security finding not found.");
  return explainFinding(finding, question, earlier);
}

/**
 * The judge's quote when the content really contains it, since the user reads it as evidence;
 * otherwise the content's start.
 */
function quotedPassage(text: string, claimed: string | undefined): string {
  const collapse = (value: string) => value.replace(/\s+/g, " ").trim();
  const quote = claimed && collapse(claimed);
  return quote && collapse(text).includes(quote)
    ? quote.slice(0, QUOTE_LENGTH)
    : collapse(text).slice(0, QUOTE_LENGTH);
}

/** The attack in a session that the user hasn't closed, which holds its risky actions. */
export async function readOpenFinding(sessionId: string): Promise<SecurityFinding | undefined> {
  const db = await getStateDatabase({ createIfMissing: false });
  return db ? new SecurityDatabase(db).findOpenFinding(sessionId) : undefined;
}

export async function listOpenSecurityFindings(): Promise<SecurityFinding[]> {
  return new SecurityDatabase(await getStateDatabase()).listOpenFindings();
}

/** One page of the closed record, which grows for as long as agents read untrusted content. */
export async function listClosedSecurityFindings(
  query: ClosedFindingsQuery,
): Promise<ClosedFindingsPage> {
  const findings = await new SecurityDatabase(await getStateDatabase()).listClosedFindings(
    query,
    CLOSED_PAGE_SIZE + 1,
  );
  if (findings.length <= CLOSED_PAGE_SIZE) return { findings };
  const page = findings.slice(0, CLOSED_PAGE_SIZE);
  const last = page.at(-1)!;
  return { findings: page, next: { closedAt: last.closed!.at, id: last.id } };
}

/** Close a finding with the user's verdict, releasing its session's holds. */
export async function closeSecurityFinding(
  findingId: string,
  outcome: FindingOutcome,
): Promise<SecurityFinding> {
  return published(
    await new SecurityDatabase(await getStateDatabase()).closeFinding(findingId, outcome),
  );
}

/** Reopen a closed finding, which holds its session's risky actions again. */
export async function reopenSecurityFinding(findingId: string): Promise<SecurityFinding> {
  return published(await new SecurityDatabase(await getStateDatabase()).reopenFinding(findingId));
}

function published(finding: SecurityFinding | undefined): SecurityFinding {
  if (!finding) throw new Error("Security finding not found.");
  broadcast({ type: "security.finding.upserted", finding });
  return finding;
}
