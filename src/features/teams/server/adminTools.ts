import { defineTool } from "@sessions/server/tools/definition";
import { checkSessionStatusTool } from "@sessions/server/tools";
import { sessionInputSchema } from "@sessions/model/protocol";
import { requireAdminLead } from "./admin";

export const adminTeamTools = [
  {
    ...checkSessionStatusTool,
    handler: async (...args: Parameters<typeof checkSessionStatusTool.handler>) => {
      await requireAdminLead(args[1].sessionId);
      return checkSessionStatusTool.handler(...args);
    },
  },
  defineTool("refresh_session_connection", {
    description:
      "Releases another session's idle provider connection without deleting history or starting a new turn. Its next normal message reconnects with current tools. Only the built-in Admin lead can invoke this. Busy or starting sessions and self-targets are refused; ask the owner to stop active work first. This does not restart the server or affect other agents.",
    parameters: sessionInputSchema.strict(),
    handler: async ({ sessionId }, invocation) => {
      await requireAdminLead(invocation.sessionId);
      if (sessionId === invocation.sessionId)
        throw new Error("Cannot refresh the invoking session.");
      const { checkSessionStatus } = await import("@/server/sessionDiagnostics");
      await checkSessionStatus({ sessionId });
      const { refreshSessionConnection } = await import("@sessions/server/runtime");
      return refreshSessionConnection(sessionId);
    },
  }),
] as const;
