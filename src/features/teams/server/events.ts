import type { TeamEvent } from "@teams/model";
import { sharedMap } from "@/shared/server/processState";

const MAX_REPLAY_EVENTS = 500;
const teams = sharedMap<{
  history: TeamEvent[];
  listeners: Set<(event: TeamEvent) => void>;
}>("team-events");

/** Publish one committed Team transition to its open clients. */
export function publishTeamEvent(teamId: string, event: TeamEvent): void {
  const events = getTeamEvents(teamId);
  events.history.push(event);
  if (events.history.length > MAX_REPLAY_EVENTS) {
    events.history.splice(0, events.history.length - MAX_REPLAY_EVENTS);
  }
  for (const listener of [...events.listeners]) listener(event);
}

/** Return ordered, deduplicated changes, or undefined when a snapshot is required. */
export function replayTeamEvents(
  teamId: string,
  afterRevision: number,
  throughRevision: number,
): TeamEvent[] | undefined {
  if (afterRevision === throughRevision) return [];
  if (afterRevision > throughRevision) return undefined;
  const replay = getTeamEvents(teamId)
    .history.filter(({ revision }) => revision > afterRevision && revision <= throughRevision)
    .sort((left, right) => left.revision - right.revision)
    .filter(
      (event, index, events) => index === 0 || event.revision !== events[index - 1]!.revision,
    );
  return replay.length === throughRevision - afterRevision ? replay : undefined;
}

export function subscribeTeamEvents(
  teamId: string,
  listener: (event: TeamEvent) => void,
): () => void {
  const events = getTeamEvents(teamId);
  events.listeners.add(listener);
  return () => events.listeners.delete(listener);
}

export function releaseTeamEvents(teamId: string): void {
  teams.delete(teamId);
}

function getTeamEvents(teamId: string) {
  let events = teams.get(teamId);
  if (!events) {
    events = { history: [], listeners: new Set() };
    teams.set(teamId, events);
  }
  return events;
}
