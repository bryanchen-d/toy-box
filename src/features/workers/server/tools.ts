import { defineTool } from "@sessions/server/tools/definition";
import { z } from "zod";
import {
  SUB_SESSION_LIMIT,
  SUB_SESSION_WAKE_MAX_MINUTES,
  subSessionRequestSchema,
} from "../model/subSessions";

export const SUB_SESSION_INSTRUCTIONS = `<sub_sessions>
You can hand a task to a sub session: a session you own that does that one task, reports each finished turn back to you, and stays open for follow-ups until you close it.
- Use your provider's own subagents for quick work inside a turn, such as a parallel search or a diff review. Use a sub session for a task that outlives your turn, needs its own review, or should run alongside your other work.
- Before you create a sub session, call list_sub_sessions: it shows the nodes you can run one on. Run it on a connected node that isn't draining, by setting its node, unless its task needs this machine's files, services, or uncommitted changes. UI work, builds, test runs, and long investigations belong on a node, which keeps this machine free for the user. A node sub session starts in an empty folder there, so name the repository and branch to work on in its brief; it pushes its progress to that branch as it goes.
- You are the expert on the task, so brief it the way you would brief a capable colleague who knows nothing yet: the goal, the context and decisions so far, the deliverable, acceptance criteria you will actually check, and its boundaries. Vague briefs come back as duplicated or misdirected work.
- Give parallel sub sessions separate parts of the work, and a worktree each when they change the same repository on this machine.
- Treat each report as a claim. Check it against your acceptance criteria and its evidence before you use it or pass it on, and send a follow-up when it falls short. A report also lists the external writes the sub session made, such as pushes and pull request or issue changes; check that each is within its brief and fits what you know.
- A report can say a sub session's run was interrupted, by a restart or by its node going out of reach. Message it to carry on once it can run again, or close it and continue the task from its brief and last pushed branch, yourself or in a new sub session, here or on another node.
- Close a sub session as soon as its task is done. You can own at most ${SUB_SESSION_LIMIT} at once.
</sub_sessions>`;

const sessionIdParameter = z
  .string()
  .describe("The sub session's ID, from create_sub_session or list_sub_sessions");

const createSubSessionTool = defineTool("create_sub_session", {
  description:
    "Creates a sub session you own to do one task, starting it with your brief. " +
    "Each finished turn reports back to you; send follow-ups with message_sub_session and close it with close_sub_session when the task is done. " +
    "Set node to run it on a pool node, which list_sub_sessions shows, instead of this machine. " +
    `It inherits your model and directory unless you set them. You can own at most ${SUB_SESSION_LIMIT} at once.`,
  parameters: subSessionRequestSchema,
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
    "Lists the sub sessions you own: each one's task, the node it runs on if any, whether it is working or idle, and a preview of its last report. With an agent pool, it also lists the pool's nodes and whether each is connected.",
  parameters: z.object({}),
  handler: async (_args, invocation) => {
    const { listSubSessions } = await import("./subSessions");
    return JSON.stringify(await listSubSessions(invocation.sessionId));
  },
});

const closeSubSessionTool = defineTool("close_sub_session", {
  description:
    "Closes one of your sub sessions once its task is done or no longer needed: stops any work it is doing and deletes it. The result lists any external writes it made that no report told you about yet.",
  parameters: z.object({ sessionId: sessionIdParameter }),
  handler: async ({ sessionId }, invocation) => {
    const { closeSubSession } = await import("./subSessions");
    return JSON.stringify(await closeSubSession(invocation.sessionId, sessionId));
  },
});

/** Tools an agent uses on the sub sessions it owns. */
export const subSessionOwnerTools = [
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
export const subSessionTools = [wakeAfterTool];
