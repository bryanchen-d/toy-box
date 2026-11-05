import { reduceTeamState } from "./model/reducer";
import {
  experimental_streamedQuery as streamedQuery,
  queryOptions,
  skipToken,
} from "@tanstack/react-query";
import {
  teamUnreadAfter,
  type TeamObservationEvent,
  type TeamState,
  type TeamMessage,
} from "./model";
import {
  getTeamThreadSequence,
  getTeamUsage,
  listTeams,
  searchTeamMessages,
} from "@teams/server/functions";
import { TeamStreamError, streamTeam } from "./stream";
import { removeTeamFromList } from "./queryCache";

/** Browser arrival is distinct from cached content and from later live updates. */
export type TeamQueryData = TeamState & {
  arrival: { id: number; unreadAfter: number | null };
  optimisticMessageIds?: string[];
};

export const teamQueries = {
  all: () => ["teams"] as const,
  listKey: () => [...teamQueries.all(), "list"] as const,
  list: () =>
    queryOptions({
      queryKey: teamQueries.listKey(),
      queryFn: listTeams,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
  details: () => [...teamQueries.all(), "detail"] as const,
  search: (teamId: string, query: string, threadSequence?: number) =>
    queryOptions({
      queryKey: [
        ...teamQueries.details(),
        teamId,
        "search",
        threadSequence ?? null,
        query,
      ] as const,
      queryFn: query
        ? ({ signal }) => searchTeamMessages({ data: { teamId, query, threadSequence }, signal })
        : skipToken,
      staleTime: 0,
      gcTime: 0,
      retry: false,
    }),
  threadSequence: (teamId: string, sequence: number) =>
    queryOptions({
      queryKey: [...teamQueries.all(), "threadSequence", teamId, sequence] as const,
      queryFn: ({ signal }) => getTeamThreadSequence({ data: { teamId, sequence }, signal }),
      staleTime: 0,
      gcTime: 0,
      retry: false,
    }),
  usage: (teamId: string) =>
    queryOptions({
      queryKey: [...teamQueries.all(), "usage", teamId] as const,
      queryFn: ({ signal }) => getTeamUsage({ data: { teamId }, signal }),
      staleTime: 5_000,
      refetchInterval: 5_000,
    }),
  detail: (teamId: string) =>
    queryOptions({
      queryKey: [...teamQueries.details(), teamId] as const,
      queryFn: streamedQuery<TeamObservationEvent, TeamQueryData | null>({
        initialValue: null,
        refetchMode: "append",
        streamFn: async function* ({ client, queryKey, signal }) {
          const cached = client.getQueryData<TeamQueryData | null>(queryKey);
          for await (const event of streamTeam(teamId, signal, cached?.revision)) {
            if (event.type === "deleted") removeTeamFromList(client, teamId);
            yield event;
          }
        },
        reducer: (previous, event) => {
          if (event.type === "deleted") return null;
          const state = reduceTeamState(previous!, event);
          const arrived = event.type === "snapshot" || event.type === "resumed";
          return {
            ...state,
            optimisticMessageIds:
              event.type === "snapshot"
                ? undefined
                : event.type === "message"
                  ? previous?.optimisticMessageIds?.filter((id) => id !== event.message.id)
                  : previous?.optimisticMessageIds,
            arrival: arrived
              ? {
                  id: (previous?.arrival.id ?? 0) + 1,
                  unreadAfter: teamUnreadAfter(state.team),
                }
              : previous!.arrival,
          };
        },
      }),
      staleTime: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: (_count, error) =>
        !(error instanceof TeamStreamError && error.status < 500 && error.status !== 429),
      retryDelay: 1_000,
    }),
  messagesBefore: (teamId: string, beforeSequence: number) =>
    queryOptions({
      queryKey: [...teamQueries.details(), teamId, "before", beforeSequence] as const,
      queryFn: async ({ signal }) => {
        const response = await fetch(
          `/api/v1/teams/${encodeURIComponent(teamId)}/messages?before=${beforeSequence}`,
          { signal },
        );
        if (!response.ok) throw new Error("Unable to load Team history.");
        return response.json() as Promise<{ revision: number; messages: TeamMessage[] }>;
      },
      staleTime: 0,
      gcTime: 0,
    }),
};
