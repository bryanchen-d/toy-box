// Advice for working better: one measured finding and one action the user can apply. Agents such as
// a performance auditor propose it; only the user applies or dismisses it, so applying acts with the
// user's authority.

import { z } from "zod";
import { createTeamInputSchema } from ".";

const durableIdSchema = z.string().trim().min(1).max(255);

export const teamAdviceActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message_lead"),
      content: z
        .string()
        .trim()
        .min(1)
        .max(3_000)
        .describe("What the user tells the lead on applying this advice, written to the lead."),
    })
    .strict(),
  z
    .object({
      type: z.literal("move_members"),
      agentIds: z
        .array(durableIdSchema)
        .min(1)
        .max(20)
        .describe("Agent IDs of current members to move; never the lead."),
      to: z.union([
        z.object({ teamId: durableIdSchema.describe("An existing team to join.") }).strict(),
        z
          .object({
            newTeam: createTeamInputSchema
              .pick({ name: true, purpose: true })
              .describe("A new team, led by its own lead, for the moved members."),
          })
          .strict(),
      ]),
    })
    .strict(),
]);
export type TeamAdviceAction = z.output<typeof teamAdviceActionSchema>;

export const proposeTeamAdviceInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120).describe("The improvement, in a few words."),
    finding: z
      .string()
      .trim()
      .min(1)
      .max(3_000)
      .describe(
        "The evidence and reasoning: measured stats and message sequences that show the problem.",
      ),
    action: teamAdviceActionSchema,
  })
  .strict();
export type ProposeTeamAdviceInput = z.output<typeof proposeTeamAdviceInputSchema>;

export type TeamAdvice = ProposeTeamAdviceInput & {
  id: string;
  /** The agent that proposed it. */
  authorId: string;
  status: "open" | "applied" | "dismissed";
  createdAt: string;
  resolvedAt?: string;
};

export const resolveTeamAdviceInputSchema = z
  .object({
    teamId: durableIdSchema,
    adviceId: durableIdSchema,
    resolution: z.enum(["apply", "dismiss"]),
  })
  .strict();
export type ResolveTeamAdviceInput = z.output<typeof resolveTeamAdviceInputSchema>;

/** Open advice first, then resolved; newest first within each. */
export function orderTeamAdvice(advice: readonly TeamAdvice[]): TeamAdvice[] {
  return [...advice].sort(
    (left, right) =>
      Number(left.status !== "open") - Number(right.status !== "open") ||
      right.createdAt.localeCompare(left.createdAt),
  );
}

export function upsertTeamAdvice(advice: readonly TeamAdvice[], next: TeamAdvice): TeamAdvice[] {
  return orderTeamAdvice([...advice.filter(({ id }) => id !== next.id), next]);
}
