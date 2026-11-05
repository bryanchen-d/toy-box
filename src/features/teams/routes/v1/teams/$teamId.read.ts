import { createFileRoute } from "@tanstack/react-router";
import { markTeamReadResponse } from "@teams/server/api";

export const Route = createFileRoute("/api/v1/teams/$teamId/read")({
  server: {
    handlers: {
      POST: ({ params, request }) => markTeamReadResponse(params.teamId, request),
    },
  },
});
