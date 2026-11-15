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

/** A sub session's own Worker metadata: the wake it scheduled, if any. */
const subSessionMetadataSchema = z.object({
  wake: z.object({ at: z.iso.datetime(), reason: z.string().min(1) }).optional(),
});
export type SubSessionWake = NonNullable<z.infer<typeof subSessionMetadataSchema>["wake"]>;

/** The scheduled wake that is due at `now`, if the metadata holds one. */
export function dueWake(metadata: unknown, now: Date): SubSessionWake | undefined {
  const wake = subSessionMetadataSchema.safeParse(metadata ?? {}).data?.wake;
  return wake && new Date(wake.at) <= now ? wake : undefined;
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
});
export type SubSessionRequest = z.infer<typeof subSessionRequestSchema>;

/** The sub session's first message: who it works for, how it reports, and its brief. */
export function renderSubSessionBrief(brief: SubSessionBrief, owner: { name?: string }): string {
  const ownerName = owner.name?.trim() || "the agent that created you";
  const sections = [
    ["Goal", brief.goal],
    ["Context", brief.context],
    ["Deliverable", brief.deliverable],
    [
      "Acceptance criteria",
      brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n"),
    ],
    ["Boundaries", brief.boundaries],
    ["Reporting", brief.reporting],
  ].filter((section): section is [string, string] => Boolean(section[1]));

  return [
    `You are a sub session doing one task for ${ownerName}, who reviews what you report and closes you when the task is done.`,
    [
      `- Your final answer at the end of each turn goes to ${ownerName} automatically, so make it a report: what you did, the deliverable, and the evidence for each acceptance criterion.`,
      "- When this brief conflicts with what you find, or you need a decision, end your turn with the question instead of guessing.",
      `- When a turn has nothing ${ownerName} needs to hear, answer with exactly ${NO_UPDATE}.`,
      "- When you are waiting on something slow, such as CI or a review, call wake_after and end your turn instead of waiting in it.",
      "- Work only on this task. You can't create sub sessions of your own; use your provider's own subagents for parallel work within a turn.",
    ].join("\n"),
    ...sections.map(([title, body]) => `## ${title}\n${body}`),
  ].join("\n\n");
}

/**
 * What a sub session's finished execution tells its owner: its final answer, or its error. An
 * execution with no answer, or one of exactly `NO_UPDATE`, tells it nothing.
 */
export function subSessionReport(
  completion: SessionCompletion,
): { outcome: "completed" | "failed"; report: string } | undefined {
  if (completion.status === "failed") {
    const report =
      completion.error?.trim() || completion.response?.trim() || "It stopped without saying why.";
    return { outcome: "failed", report: clip(report) };
  }
  if (completion.status !== "completed") return undefined;
  const report = completion.response?.trim();
  if (!report || report === NO_UPDATE) return undefined;
  return { outcome: "completed", report: clip(report) };
}

function clip(text: string): string {
  return text.length <= REPORT_MAX_LENGTH
    ? text
    : `${text.slice(0, REPORT_MAX_LENGTH)}\n\n(The report was cut at ${REPORT_MAX_LENGTH} characters.)`;
}
