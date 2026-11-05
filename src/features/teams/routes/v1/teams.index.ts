import { createFileRoute } from "@tanstack/react-router";
import { listTeams } from "@teams/server";

export const Route = createFileRoute("/api/v1/teams/")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(
          { version: 1, ...(await listTeams()) },
          { headers: { "Cache-Control": "no-store" } },
        ),
    },
  },
});
