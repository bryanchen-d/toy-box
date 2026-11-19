// A sub session is a session-owned Worker that does one task for the agent that created it and
// reports back to it. The owner briefs it, reviews each report, and closes it when the task is done.

import { z } from "zod";
import { modelConfigurationSchema } from "@providers/model";
import type { SessionCompletion } from "@sessions/model";
import { workerNameSchema } from ".";

/** The most sub sessions one session may own at once. */
export const SUB_SESSION_LIMIT = 5;

/** A sub session's whole answer when it checked and found nothing its owner needs to hear. */
export const NO_UPDATE = "NO_UPDATE";

const REPORT_MAX_LENGTH = 20_000;

/** The longest a sub session may sleep before checking back. */
export const SUB_SESSION_WAKE_MAX_MINUTES = 24 * 60;

/** How long a sub session may sit idle after reporting before its owner is reminded it's open. */
export const SUB_SESSION_REMINDER_MS = 24 * 60 * 60_000;

/**
 * A sub session's own Worker metadata: the brief it was created with, which its owner gets back
 * if its run is interrupted; whether a run is under way, so a restart can tell its owner it
 * stopped; the wake it scheduled; and when to remind its owner that it is still open after its
 * last report.
 */
const subSessionMetadataSchema = z.object({
  brief: z.lazy(() => subSessionBriefSchema).optional(),
  working: z.literal(true).optional(),
  wake: z.object({ at: z.iso.datetime(), reason: z.string().min(1) }).optional(),
  remindAt: z.iso.datetime().optional(),
});
export type SubSessionMetadata = z.infer<typeof subSessionMetadataSchema>;
export type SubSessionWake = NonNullable<SubSessionMetadata["wake"]>;

export function readSubSessionMetadata(metadata: unknown): SubSessionMetadata {
  return subSessionMetadataSchema.safeParse(metadata ?? {}).data ?? {};
}

/** The scheduled wake that is due at `now`, if the metadata holds one. */
export function dueWake(metadata: unknown, now: Date): SubSessionWake | undefined {
  const { wake } = readSubSessionMetadata(metadata);
  return wake && new Date(wake.at) <= now ? wake : undefined;
}

/** A sub session waiting on its own wake isn't forgotten, so its owner isn't reminded yet. */
export function isReminderDue(metadata: unknown, now: Date): boolean {
  const { wake, remindAt } = readSubSessionMetadata(metadata);
  return !wake && remindAt !== undefined && new Date(remindAt) <= now;
}

const briefText = z.string().trim().min(1).max(20_000);

export const subSessionBriefSchema = z
  .object({
    goal: briefText.describe("The one outcome this sub session owns, in a sentence or two."),
    context: briefText.describe(
      "Everything it needs to start well: findings so far, decisions already made and why, relevant files, links, and commits, and what has been ruled out.",
    ),
    deliverable: briefText.describe(
      "What to hand back and in what form, such as a pull request link, a file path, or a written answer.",
    ),
    acceptanceCriteria: z
      .array(z.string().trim().min(1).max(2_000))
      .min(1)
      .max(20)
      .describe("The checks you will apply to its report, each specific enough to verify."),
    boundaries: briefText
      .optional()
      .describe("What it must not do or change, and where its work stops."),
    reporting: briefText
      .optional()
      .describe(
        "What each report must include beyond the deliverable, such as evidence or test output.",
      ),
  })
  .strict();
export type SubSessionBrief = z.infer<typeof subSessionBriefSchema>;

/** What an owner asks for when it creates a sub session. */
export const subSessionRequestSchema = z.object({
  name: workerNameSchema.describe(
    "A short label for the task, shown wherever the sub session is listed.",
  ),
  brief: subSessionBriefSchema,
  model: modelConfigurationSchema
    .optional()
    .describe("Optional model and reasoning configuration for the sub session."),
  directory: z.string().optional().describe("Optional working directory for the sub session."),
  useWorktree: z
    .boolean()
    .optional()
    .describe("Whether to isolate the sub session in its own git worktree. Defaults to false."),
  node: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "A node to run the sub session on, by the name its agent pool lists it under, for work that needs its own machine, such as driving a UI. It starts in a fresh folder there, so leave directory and useWorktree unset; a model you name applies only if the node offers it.",
    ),
});
export type SubSessionRequest = z.infer<typeof subSessionRequestSchema>;

/** The sub session's first message: who it works for, how it reports, and its brief. */
export function renderSubSessionBrief(
  brief: SubSessionBrief,
  owner: { name?: string; node?: string },
): string {
  const ownerName = owner.name?.trim() || "the agent that created you";
  return [
    `You are a sub session doing one task for ${ownerName}, who reviews what you report and closes you when the task is done.`,
    [
      `- Your final answer at the end of each turn goes to ${ownerName} automatically, so make it a report: what you did, the deliverable, and the evidence for each acceptance criterion.`,
      "- When this brief conflicts with what you find, or you need a decision, end your turn with the question instead of guessing.",
      `- When a turn has nothing ${ownerName} needs to hear, answer with exactly ${NO_UPDATE}.`,
      "- When you are waiting on something slow, such as CI or a review, call wake_after and end your turn instead of waiting in it.",
      "- Work only on this task. You can't create sub sessions of your own; use your provider's own subagents for parallel work within a turn.",
      ...(owner.node
        ? [
            `- You run on ${owner.node}, a separate machine, in an empty folder of your own. Work on your own branch of the repository the brief names, and commit and push at each milestone, naming the branch and its last pushed commit in every report, so your work survives if this session is lost.`,
          ]
        : []),
    ].join("\n"),
    renderBriefSections(brief),
  ].join("\n\n");
}

/** The brief's own sections, as its sub session and an owner taking the task over read them. */
export function renderBriefSections(brief: SubSessionBrief): string {
  return [
    ["Goal", brief.goal],
    ["Context", brief.context],
    ["Deliverable", brief.deliverable],
    [
      "Acceptance criteria",
      brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
    ],
    ["Boundaries", brief.boundaries],
    ["Reporting", brief.reporting],
  ]
    .filter((section): section is [string, string] => Boolean(section[1]))
    .map(([title, body]) => `## ${title}\n${body}`)
    .join("\n\n");
}

type SubSessionReport = {
  outcome: "completed" | "failed" | "interrupted";
  report: string;
  externalWrites?: string[];
  /** An interrupted sub session's brief, so its owner can redo the task elsewhere. */
  brief?: string;
};

/**
 * What a sub session's finished execution tells its owner: its final answer or its error, with
 * the external writes it made since its last report. An execution with no answer, or one of
 * exactly `NO_UPDATE`, tells it nothing unless it made external writes, which its owner reviews.
 */
export function subSessionReport(
  completion: SessionCompletion,
  externalWrites: readonly string[] = [],
): SubSessionReport | undefined {
  const writes = externalWrites.length > 0 ? { externalWrites: [...externalWrites] } : {};
  if (completion.status === "failed") {
    const report =
      completion.error?.trim() || completion.response?.trim() || "It stopped without saying why.";
    return { outcome: "failed", report: clip(report), ...writes };
  }
  const answer = completion.status === "completed" ? completion.response?.trim() : undefined;
  if (answer && answer !== NO_UPDATE)
    return { outcome: "completed", report: clip(answer), ...writes };
  if (externalWrites.length === 0) return undefined;
  return { outcome: "completed", report: "It had nothing else to report.", ...writes };
}

/**
 * What an owner hears when a sub session's run stopped before it could finish: Agent Teams
 * restarted, or its node went out of reach. Its brief comes back with it, since the run may need
 * redoing elsewhere.
 */
export function interruptedReport(
  reason: string,
  brief: SubSessionBrief | undefined,
  externalWrites: readonly string[] = [],
): SubSessionReport {
  return {
    outcome: "interrupted",
    report: clip(reason),
    ...(externalWrites.length > 0 ? { externalWrites: [...externalWrites] } : {}),
    ...(brief ? { brief: clip(renderBriefSections(brief)) } : {}),
  };
}

/**
 * One line about an owner's sub sessions: how many it has, how many are at work, and how many
 * run on each node, such as "3 sub sessions · 1 working · 2 on brchen-db3".
 */
export function describeSubSessions(
  subSessions: readonly { working: boolean; node?: string }[],
): string {
  const count = subSessions.length;
  const working = subSessions.filter((subSession) => subSession.working).length;
  const byNode = new Map<string, number>();
  for (const { node } of subSessions) {
    if (node !== undefined) byNode.set(node, (byNode.get(node) ?? 0) + 1);
  }
  return [
    `${count} sub session${count === 1 ? "" : "s"}`,
    ...(working > 0 ? [`${working} working`] : []),
    ...[...byNode].map(([node, onNode]) => `${onNode} on ${node}`),
  ].join(" · ");
}

/** How far back the history of sub sessions is counted. */
export const SUB_SESSION_HISTORY_MS = 7 * 24 * 60 * 60_000;

/** A sub session as its history keeps it, including after it closes. */
export type SubSessionRecord = {
  sessionId: string;
  ownerSessionId: string;
  /** The team its owner belonged to when it was created. */
  teamId?: string;
  /** The pool node it ran on; absent when it ran on this machine. */
  node?: string;
  name?: string;
  createdAt: string;
  closedAt?: string;
};

/** How many sub sessions opened and closed in a period. */
export type SubSessionCounts = { created: number; closed: number };

/**
 * How sub sessions were used: those created and closed in the last day and the last week, and
 * how many each owner created in the week, most first.
 */
export function countSubSessionUse(
  records: readonly SubSessionRecord[],
  now: Date,
): {
  day: SubSessionCounts;
  week: SubSessionCounts;
  byOwner: { ownerSessionId: string; teamId?: string; created: number }[];
} {
  const dayStart = now.getTime() - 24 * 60 * 60_000;
  const weekStart = now.getTime() - SUB_SESSION_HISTORY_MS;
  const within = (at: string | undefined, start: number) =>
    at !== undefined && Date.parse(at) >= start;
  const counts = (start: number): SubSessionCounts => ({
    created: records.filter(({ createdAt }) => within(createdAt, start)).length,
    closed: records.filter(({ closedAt }) => within(closedAt, start)).length,
  });
  const byOwner = new Map<string, { ownerSessionId: string; teamId?: string; created: number }>();
  for (const { ownerSessionId, teamId, createdAt } of records) {
    if (!within(createdAt, weekStart)) continue;
    const owner = byOwner.get(ownerSessionId) ?? {
      ownerSessionId,
      ...(teamId ? { teamId } : {}),
      created: 0,
    };
    byOwner.set(ownerSessionId, { ...owner, created: owner.created + 1 });
  }
  return {
    day: counts(dayStart),
    week: counts(weekStart),
    byOwner: [...byOwner.values()].sort(
      (left, right) =>
        right.created - left.created || left.ownerSessionId.localeCompare(right.ownerSessionId),
    ),
  };
}

function clip(text: string): string {
  return text.length <= REPORT_MAX_LENGTH
    ? text
    : `${text.slice(0, REPORT_MAX_LENGTH)}\n\n(The report was cut at ${REPORT_MAX_LENGTH} characters.)`;
}
