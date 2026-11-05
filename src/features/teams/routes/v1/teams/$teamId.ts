import { createFileRoute } from "@tanstack/react-router";
import { getTeamResponse } from "@teams/server/api";

export const Route = createFileRoute("/api/v1/teams/$teamId")({
  server: {
    handlers: {
      GET: ({ params, request }) => getTeamResponse(params.teamId, request),
    },
  },
});
