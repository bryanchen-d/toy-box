import { defineTool } from "@sessions/server/tools/definition";
import { z } from "zod";
import { modelConfigurationSchema } from "@providers/model";
import { workerNameSchema } from "../model";
import {
  SUB_SESSION_LIMIT,
  SUB_SESSION_WAKE_MAX_MINUTES,
  subSessionBriefSchema,
} from "../model/subSessions";

export const SUB_SESSION_INSTRUCTIONS = `<sub_sessions>
You can hand a task to a sub session: a session you own that does that one task, reports each finished turn back to you, and stays open for follow-ups until you close it.
- Use your provider's own subagents for quick work inside a turn, such as a parallel search or a diff review. Use a sub session for a task that outlives your turn, needs its own review, or should run alongside your other work.
- You are the expert on the task, so brief it the way you would brief a capable colleague who knows nothing yet: the goal, the context and decisions so far, the deliverable, acceptance criteria you will actually check, and its boundaries. Vague briefs come back as duplicated or misdirected work.
- Give parallel sub sessions separate parts of the work, and a worktree each when they change the same repository.
- Treat each report as a claim. Check it against your acceptance criteria and its evidence before you use it or pass it on, and send a follow-up when it falls short.
- Close a sub session as soon as its task is done. You can own at most ${SUB_SESSION_LIMIT} at once.
</sub_sessions>`;

const sessionIdParameter = z
  .string()
  .describe("The sub session's ID, from create_sub_session or list_sub_sessions");

const createSubSessionTool = defineTool("create_sub_session", {
  description:
    "Creates a sub session you own to do one task, starting it with your brief. " +
    "Each finished turn reports back to you; send follow-ups with message_sub_session and close it with close_sub_session when the task is done. " +
    `It inherits your model and directory unless you set them. You can own at most ${SUB_SESSION_LIMIT} at once.`,
  parameters: z.object({
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
  }),
  handler: async (request, invocation) => {
    const { createSubSession } = await import("./subSessions");
    return JSON.stringify(await createSubSession(invocation.sessionId, request));
  },
});

const messageSubSessionTool = defineTool("message_sub_session", {
  description:
    "Sends one of your sub sessions a follow-up, such as a correction, an answer to its question, or the next step. " +
    "It starts the sub session's next turn, or waits behind the turn it is running.",
  parameters: z.object({
    sessionId: sessionIdParameter,
    message: z.string().trim().min(1).describe("The message to send"),
  }),
  handler: async ({ sessionId, message }, invocation) => {
    const { messageSubSession } = await import("./subSessions");
    return JSON.stringify(
      await messageSubSession(invocation.sessionId, sessionId, message, invocation.toolCallId),
    );
  },
});

const listSubSessionsTool = defineTool("list_sub_sessions", {
  description:
    "Lists the sub sessions you own: each one's task, whether it is working or idle, and a preview of its last report.",
  parameters: z.object({}),
  handler: async (_args, invocation) => {
    const { listSubSessions } = await import("./subSessions");
    return JSON.stringify(await listSubSessions(invocation.sessionId));
  },
});

const closeSubSessionTool = defineTool("close_sub_session", {
  description:
    "Closes one of your sub sessions once its task is done or no longer needed: stops any work it is doing and deletes it.",
  parameters: z.object({ sessionId: sessionIdParameter }),
  handler: async ({ sessionId }, invocation) => {
    const { closeSubSession } = await import("./subSessions");
    return JSON.stringify(await closeSubSession(invocation.sessionId, sessionId));
  },
});

export const subSessionTools = [
  createSubSessionTool,
  messageSubSessionTool,
  listSubSessionsTool,
  closeSubSessionTool,
];

const wakeAfterTool = defineTool("wake_after", {
  description:
    "Schedules your next turn after a delay while you wait on something slow, such as CI, a review, or a deploy. " +
    "End your turn after calling it. Calling it again replaces the earlier wake, and a message from your owner cancels it.",
  parameters: z.object({
    minutes: z
      .number()
      .int()
      .min(1)
      .max(SUB_SESSION_WAKE_MAX_MINUTES)
      .describe("How many minutes from now to wake"),
    reason: z.string().trim().min(1).max(500).describe("What you are waiting for"),
  }),
  handler: async ({ minutes, reason }, invocation) => {
    const { scheduleWake } = await import("./subSessions");
    return JSON.stringify(await scheduleWake(invocation.sessionId, minutes, reason));
  },
});

/** Tools a sub session uses on itself. */
export const subSessionSelfTools = [wakeAfterTool];
