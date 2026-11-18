import { defineTool } from "@sessions/server/tools/definition";
import { z } from "zod";
import { sessionNameSchema, sessionStatusInputSchema } from "@sessions/model/protocol";
import { modelConfigurationSchema } from "@providers/model";
import { previewUpdateSchema } from "@/shared/preview";

export const STANDARD_SESSION_INSTRUCTIONS =
  "Keep this session's title recognizable. Before completing the first turn, you MUST call `update_session_title` once with a concise 2-6 word title after understanding the user's initial intent. On later turns, call it again before responding only when the session's focus has changed materially, not for ordinary follow-ups or refinements. Do not mention routine title updates to the user.";

export const HYPER_SESSION_INSTRUCTIONS =
  "This is Agent Teams' Hyper session, a global floating session window for observing other sessions, managing the Agent Teams environment, answering questions, and performing tasks. Use check_session_status without a sessionId for a read-only workspace overview, or with a sessionId to inspect one session. It reports runtime phase, team ownership, queued prompts, observed provider activity, and cached tool-definition freshness without starting or interrupting work. Background or quiet does not mean stuck. Connection status describes our local handle, not remote network liveness. An untracked tool configuration is unknown, not current. Report evidence before recommending recovery, and never stop work or delete sessions just to diagnose it.";

const updateSessionTitleTool = defineTool("update_session_title", {
  description:
    "Updates this session's automatic title to match its current focus. " +
    "Call after the initial focus is clear and again only when it materially changes. " +
    "A title explicitly set by the user is preserved.",
  parameters: z.object({
    title: sessionNameSchema.describe("Concise 2-6 word title for the current focus"),
  }),
  handler: async ({ title }, invocation) => {
    const { updateSessionTitle } = await import("@sessions/server/state/registry");
    return JSON.stringify({
      applied: await updateSessionTitle(invocation.sessionId, title),
    });
  },
});

export const sessionTitleTools = [updateSessionTitleTool];

export const modelTools = [
  defineTool("list_models", {
    description:
      "Lists available providers and models with the IDs and options needed to configure sessions and team members.",
    parameters: z
      .object({
        provider: z
          .enum(["copilot", "codex", "claude"])
          .optional()
          .describe("Optional provider filter. Omit it to return every available model."),
      })
      .strict(),
    handler: async ({ provider }) => {
      const models = await (await import("@providers/server")).listModels();
      return provider ? models.filter((model) => model.provider === provider) : models;
    },
  }),
] as const;

export const sessionHistoryTools = [
  defineTool("list_sessions", {
    description:
      "Discover Agent Teams and native session histories across available providers. Returns session metadata, newest first, and the total number of matches. Search by title to narrow the results.",
    parameters: z.object({
      query: z.string().optional().describe("Optional case-insensitive title substring."),
      limit: z.number().int().min(1).max(100).optional().describe("Maximum results (default 20)."),
    }),
    handler: async ({ query, limit = 20 }) => {
      const title = query?.trim().toLowerCase();
      const sessions = (await (await import("./providers")).listSessions())
        .filter(
          (session) => session.provider && (!title || session.title?.toLowerCase().includes(title)),
        )
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      return { sessions: sessions.slice(0, limit), total: sessions.length };
    },
  }),
  defineTool("read_session", {
    description:
      "Read a session's conversation and artifacts using its public Agent Teams session ID.",
    parameters: z.object({ sessionId: z.string() }),
    handler: async ({ sessionId }) => (await import("./runtime")).getSessionSnapshot(sessionId),
  }),
] as const;

export const checkSessionStatusTool = defineTool("check_session_status", {
  description:
    "Read-only session diagnostics. Pass sessionId for one session, or omit it for a paged overview of retained local sessions and all managed agents (limit defaults to 50, maximum 100; offset pages further). Returns running and queuedCount plus starting/running/background/waiting/idle phase, ownership, observed provider activity, and local connection/tool-registration state. Never starts, resumes, interrupts, or reads private session history. Does not scan native provider catalogs. Cached handles do not prove network liveness, and inactivity is not proof of a stuck agent. Tool freshness compares declarations only, not model or instruction changes. Missing sessions fail explicitly.",
  parameters: sessionStatusInputSchema,
  handler: async (input): Promise<string> => {
    const { checkSessionStatus } = await import("@/server/sessionDiagnostics");
    return JSON.stringify(await checkSessionStatus(input));
  },
});

const waitForSessions = defineTool("wait_for_sessions", {
  description:
    "Waits for one or more sessions' current executions to complete before returning. " +
    "Returns each completion status and latest assistant response when available. Timing out does not abort the session.",
  parameters: z.object({
    sessionIds: z.array(z.string()).min(1).describe("One or more session IDs to wait for"),
    timeoutMs: z
      .number()
      .int()
      .nonnegative()
      .max(300000)
      .optional()
      .describe("Optional maximum time to wait in milliseconds"),
  }),
  handler: async ({ sessionIds, timeoutMs }) => {
    const { waitForSessions } = await import("@sessions/server/runtime");
    const completions = await waitForSessions(sessionIds, timeoutMs);
    return JSON.stringify({
      responses: completions.map((completion, index) => ({
        sessionId: sessionIds[index]!,
        ...completion,
      })),
    });
  },
});

const deliverMessage = defineTool("deliver_message", {
  description:
    "Delivers a message to another Agent Teams session. Never target the invoking session; " +
    "subagent results return to their parent through the provider automatically. " +
    "If that session is already running, the message is queued automatically. " +
    "If it is idle, the session is resumed and the message starts immediately.",
  parameters: z.object({
    sessionId: z.string().describe("The ID of the session to receive the message"),
    message: z.string().describe("The message to deliver"),
    model: modelConfigurationSchema
      .optional()
      .describe("Optional model and reasoning override for this message"),
  }),
  handler: async ({ sessionId, message, model }, invocation) => {
    if (sessionId === invocation.sessionId) {
      throw new Error("deliver_message cannot target the invoking session.");
    }

    const { deliverSessionMessage } = await import("@sessions/server/runtime");

    const { disposition } = await deliverSessionMessage(sessionId, {
      clientId: invocation.toolCallId,
      content: message,
      model,
    });

    return JSON.stringify({ disposition });
  },
});

export const coordinationTools = [checkSessionStatusTool, waitForSessions, deliverMessage] as const;

const sessionExecutionParameters = {
  model: modelConfigurationSchema
    .optional()
    .describe("Optional model and reasoning configuration for the new session."),
  directory: z.string().optional().describe("Optional working directory for the new session."),
  useWorktree: z
    .boolean()
    .optional()
    .describe("Whether to create the session in a git worktree. Defaults to false."),
};

const createSessionTool = defineTool("create_session", {
  description:
    "Creates an independent top-level session for work that should remain available outside this Hyper session. " +
    "The session appears in the normal session list and is not deleted with this Hyper session. Model and directory are used only when explicitly supplied. Omitted values use normal new-session defaults. " +
    "It does not open by default: `open` defaults to false. Set it to true to open the session immediately, or call `open_session` later with the returned session ID.",
  parameters: z.object({
    prompt: z.string().describe("The initial prompt to send to the new session"),
    ...sessionExecutionParameters,
    open: z
      .boolean()
      .optional()
      .describe("Whether to open the new session as a linked pane. Defaults to false."),
  }),
  handler: async (args) => {
    const { createSession } = await import("@sessions/server/runtime");
    const sessionId = crypto.randomUUID();

    await createSession(
      sessionId,
      { content: args.prompt, model: args.model },
      {
        directory: args.directory,
        sessionType: "standard",
        useWorktree: args.useWorktree ?? false,
      },
    );

    return JSON.stringify({ sessionId, opened: args.open ?? false });
  },
});

const openSession = defineTool("open_session", {
  description:
    "Opens another session alongside this one in the sessions grid. " +
    "Use this when the user asks to view, compare, or work with multiple sessions at once. " +
    "The grid supports up to 4 sessions at a time.",
  parameters: z.object({
    sessionId: z.string().describe("The ID of the session to open alongside this one"),
  }),
  handler: ({ sessionId }) => `Session ${sessionId} opened.`,
});

const closeSession = defineTool("close_session", {
  description:
    "Closes a session from the sessions grid. " +
    "The session itself is not deleted, just removed from the visible grid.",
  parameters: z.object({
    sessionId: z.string().describe("The ID of the session to remove from the grid"),
  }),
  handler: ({ sessionId }) => `Session ${sessionId} closed.`,
});

const deleteSessionTool = defineTool("delete_session", {
  description:
    "Deletes another session when it is no longer needed. " +
    "This removes the session from storage and cleans up its runtime state.",
  parameters: z.object({
    sessionId: z.string().describe("The ID of the session to delete"),
  }),
  handler: async ({ sessionId }) => {
    const { deleteSession } = await import("@sessions/server/runtime");

    await deleteSession(sessionId);
    return JSON.stringify({ deleted: true });
  },
});

export const hyperLifecycleTools = [createSessionTool];
export const lifecycleTools = [deleteSessionTool];
const setSessionPreview = defineTool("set_session_preview", {
  description:
    "Sets this session's current runnable preview to {kind:'url',url}, {kind:'screen',screenId}, or null to clear it. " +
    "A screen preview shows a display or window from list_screens. Changing this reference does not stop any application or screen. " +
    "Use a preview for a runnable experience, and ordinary artifacts for files.",
  parameters: previewUpdateSchema,
  handler: ({ preview }) => ({ preview }),
});

export const sessionLayoutTools = [openSession, closeSession, setSessionPreview];
