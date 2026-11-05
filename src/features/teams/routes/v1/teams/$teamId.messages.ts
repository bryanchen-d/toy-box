import { createFileRoute } from "@tanstack/react-router";
import { getTeamHistoryResponse, postTeamMessageResponse } from "@teams/server/api";

export const Route = createFileRoute("/api/v1/teams/$teamId/messages")({
  server: {
    handlers: {
      GET: ({ params, request }) => getTeamHistoryResponse(params.teamId, request),
      POST: ({ params, request }) => postTeamMessageResponse(params.teamId, request),
    },
  },
});
