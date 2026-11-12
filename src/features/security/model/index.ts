import { z } from "zod";

/**
 * What a native tool call does, as far as Agent Teams' security policy is concerned. Providers
 * translate their native calls into these; anything else, including Agent Teams' own tools, is
 * an ordinary `tool`.
 */
export type AgentAction =
  | { type: "command"; command: string }
  | { type: "fetch"; url: string }
  | { type: "search"; query: string }
  | { type: "mcp"; server: string; tool: string }
  | { type: "write"; paths: string[] }
  | { type: "tool"; name: string };

/** Text written by someone other than the owner, and who or where it came from. */
export type UntrustedContent = { source: string; text: string };

/**
 * The judge's verdict on untrusted content: whether it tries to steer an agent, toward what, the
 * passage that does it when the judge could point to one, and why that's risky.
 */
export type Screening =
  | { attack: false }
  | { attack: true; action: string; quote?: string; reason: string };

/** How the user closed a finding: content that wasn't an attack, or a real attack they handled. */
export const FINDING_OUTCOMES = ["false-positive", "attack"] as const;
export type FindingOutcome = (typeof FINDING_OUTCOMES)[number];

/**
 * A durable record of untrusted content judged to be an injection attempt. While it's open, its
 * session's risky actions are held.
 */
export type SecurityFinding = {
  id: string;
  sessionId: string;
  /** Who or where the content came from, such as "Alex in Slack, via BryanBot". */
  source: string;
  /** What the content tried to make an agent do. */
  action: string;
  /** The passage that does it, verbatim from the content. */
  quote: string;
  /** Why the judge considered it risky. */
  reason: string;
  /** The start of the flagged content, for context around the quote. */
  excerpt: string;
  detectedAt: string;
  /** Set when the user closes it, which releases its session's holds; reopening clears it. */
  closed?: { outcome: FindingOutcome; at: string };
};

export const securityFindingIdInputSchema = z.object({ findingId: z.string().min(1) }).strict();

export const closeSecurityFindingInputSchema = securityFindingIdInputSchema
  .extend({ outcome: z.enum(FINDING_OUTCOMES) })
  .strict();

/** Closed findings list newest first; a page resumes before the last finding of the one ahead. */
const closedFindingsCursorSchema = z
  .object({ closedAt: z.string().min(1), id: z.string().min(1) })
  .strict();
export type ClosedFindingsCursor = z.infer<typeof closedFindingsCursorSchema>;

/** A page of closed findings, of every session or only some, such as a team's agents. */
export const closedSecurityFindingsInputSchema = z
  .object({
    sessionIds: z.array(z.string().min(1)).max(500).optional(),
    before: closedFindingsCursorSchema.optional(),
  })
  .strict();
export type ClosedFindingsQuery = z.infer<typeof closedSecurityFindingsInputSchema>;
export type ClosedFindingsPage = { findings: SecurityFinding[]; next?: ClosedFindingsCursor };

/** A question about a finding, with the earlier exchanges it follows up on. */
export const explainSecurityFindingInputSchema = securityFindingIdInputSchema
  .extend({
    question: z.string().trim().max(1_000),
    earlier: z
      .array(z.object({ question: z.string().max(1_000), answer: z.string().max(4_000) }).strict())
      .max(6),
  })
  .strict();

export type FindingExchange = z.infer<typeof explainSecurityFindingInputSchema>["earlier"][number];
