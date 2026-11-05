import { EventSourceParserStream } from "eventsource-parser/stream";
import type { TeamObservationEvent } from "./model";

export class TeamStreamError extends Error {
  constructor(readonly status: number) {
    super(`Unable to connect to the Team (HTTP ${status}).`);
  }
}

/** One observation attempt. Query retries from its current cached revision. */
export async function* streamTeam(
  teamId: string,
  signal: AbortSignal,
  after?: number,
): AsyncGenerator<TeamObservationEvent> {
  const url = `/api/v1/teams/${encodeURIComponent(teamId)}`;
  const response = await fetch(after === undefined ? url : `${url}?after=${after}`, {
    signal,
    headers: { Accept: "text/event-stream" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new TeamStreamError(response.status);
  }
  if (!response.body) throw new Error("The Team stream has no response body.");

  const events = response.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream());
  const reader = events.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("The Team connection ended before deletion.");
      const event = JSON.parse(value.data) as TeamObservationEvent;
      yield event;
      if (event.type === "deleted") return;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
