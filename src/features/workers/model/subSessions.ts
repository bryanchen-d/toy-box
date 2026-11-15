// A sub session is a session-owned Worker that does one task for the agent that created it and
// reports back to it. The owner briefs it, reviews each report, and closes it when the task is done.

import { z } from "zod";

/** The most sub sessions one session may own at once. */
export const SUB_SESSION_LIMIT = 5;

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
      "- Work only on this task. You can't create sub sessions of your own; use your provider's own subagents for parallel work within a turn.",
    ].join("\n"),
    ...sections.map(([title, body]) => `## ${title}\n${body}`),
  ].join("\n\n");
}
