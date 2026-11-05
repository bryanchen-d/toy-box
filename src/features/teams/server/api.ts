import {
  teamIdentitySchema,
  markTeamReadInputSchema,
  postTeamMessageInputSchema,
} from "@teams/model";
import { createSseResponse } from "@/shared/server/sse";
import { getTeamHistory, markTeamRead, postTeamMessage } from ".";
import { streamTeam } from "./stream";

/** HTTP ingress over the public Team capabilities. */
export function getTeamResponse(teamId: string, request: Request): Response {
  if (!teamIdentitySchema.safeParse({ teamId }).success) return invalidRequest();
  return createSseResponse(request, (send, close) =>
    streamTeam(
      teamId,
      (event) =>
        send(
          event,
          event.type === "snapshot"
            ? event.state.revision
            : "revision" in event
              ? event.revision
              : undefined,
        ),
      close,
      readAfterRevision(request),
    ),
  );
}

function readAfterRevision(request: Request): number | undefined {
  const value =
    request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("after");
  if (value === null || value.trim() === "") return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

export async function getTeamHistoryResponse(teamId: string, request: Request): Promise<Response> {
  const before = Number(new URL(request.url).searchParams.get("before"));
  if (
    !teamIdentitySchema.safeParse({ teamId }).success ||
    !Number.isSafeInteger(before) ||
    before <= 0
  )
    return invalidRequest();
  const page = await getTeamHistory(teamId, before);
  return page
    ? Response.json({ version: 1, ...page }, { headers: { "Cache-Control": "no-store" } })
    : missingTeam();
}

export async function postTeamMessageResponse(teamId: string, request: Request): Promise<Response> {
  const input = await readInput(teamId, request, postTeamMessageInputSchema);
  if (!input) return invalidRequest();
  try {
    return Response.json({ version: 1, message: await postTeamMessage(input) }, { status: 201 });
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "SQLITE_CONSTRAINT_PRIMARYKEY"
    ) {
      return Response.json({ error: "Message ID already exists." }, { status: 409 });
    }
    if (error instanceof Error && error.message === "Team not found.") return missingTeam();
    console.error(`Failed to post to Team ${teamId}:`, error);
    return Response.json({ error: "Unable to post Team message." }, { status: 500 });
  }
}

export async function markTeamReadResponse(teamId: string, request: Request): Promise<Response> {
  const input = await readInput(teamId, request, markTeamReadInputSchema);
  if (!input) return invalidRequest();
  try {
    const team = await markTeamRead(input.teamId, input.sequence);
    if (!team) return missingTeam();
    return Response.json({ version: 1, seenThrough: team.seenThrough });
  } catch (error) {
    console.error(`Failed to mark Team ${teamId} read:`, error);
    return Response.json({ error: "Unable to mark Team read." }, { status: 500 });
  }
}

/** Command bodies cannot override the Team named by the route. */
async function readInput<T>(
  teamId: string,
  request: Request,
  schema: { parse(input: unknown): T },
) {
  try {
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
      return;
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || "teamId" in body) return;
    return schema.parse({ ...body, teamId });
  } catch {
    return;
  }
}

function invalidRequest(): Response {
  return Response.json({ error: "Invalid Team request." }, { status: 400 });
}

function missingTeam(): Response {
  return Response.json({ error: "Team not found." }, { status: 404 });
}
