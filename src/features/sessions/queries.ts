import { queryOptions, skipToken } from "@tanstack/react-query";
import type { SessionsState, SessionType } from "./model";
import { sessionFetch } from "./observeSession";
import {
  getSessionsState,
  listSkills,
  querySession,
  resolveSessionContext,
} from "./server/functions";

export const sessionQueries = {
  all: () => ["sessions"] as const,

  stateKey: () => [...sessionQueries.all(), "state"] as const,

  // Durable sidebar/list snapshot. Shared lifecycle and composer state lives
  // in the workspace state query.
  state: () =>
    queryOptions({
      queryKey: sessionQueries.stateKey(),
      queryFn: getSessionsState,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),

  context: (directory?: string) =>
    queryOptions({
      queryKey: [...sessionQueries.all(), "context", directory ?? null] as const,
      queryFn: directory ? () => resolveSessionContext({ data: { directory } }) : skipToken,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      retry: false,
    }),

  details: () => [...sessionQueries.all(), "detail"] as const,

  detail: (sessionId: string) =>
    queryOptions({
      queryKey: [...sessionQueries.details(), sessionId] as const,
      queryFn: ({ signal }) => querySession({ data: { sessionId }, signal, fetch: sessionFetch }),
      staleTime: 0, // Always refetch when entering a session to get latest messages
      refetchOnWindowFocus: "always",
      refetchOnReconnect: "always",
      retry: false, // Don't retry on "session not found" errors
    }),
};

export function createEmptySessionsState(): SessionsState {
  return {
    sessions: [],
    worktrees: {},
    ownership: {},
  };
}

/** Exclude Worker backing Sessions while preserving their metadata for owning surfaces. */
export function selectNonWorkerSessions(state: SessionsState): SessionsState["sessions"] {
  return state.sessions.filter(({ id }) => state.ownership[id]?.type !== "worker");
}

/** The sidebar's root population, before its local search and display limit. */
export function selectTopLevelSessions(
  state: Pick<SessionsState, "sessions" | "ownership">,
  hyperSessionIds: readonly string[],
): SessionsState["sessions"] {
  return state.sessions.filter(({ id }) => !state.ownership[id] && !hyperSessionIds.includes(id));
}

/** Index child sessions by their durable parent, including retained and nested workers. */
export function selectSessionChildren(
  state: SessionsState,
): Record<string, SessionsState["sessions"]> {
  const childrenByParent: Record<string, SessionsState["sessions"]> = {};
  for (const session of state.sessions) {
    const owner = state.ownership[session.id];
    if (owner?.type !== "worker" || !owner.parentSessionId) continue;
    (childrenByParent[owner.parentSessionId] ??= []).push(session);
  }
  return childrenByParent;
}

export function selectAutomationSessionIds(state: SessionsState): string[] {
  return Object.keys(state.ownership).filter((id) => state.ownership[id]?.type === "automation");
}

/** Skills by directory, session type, and provider; no directory means host-level discovery. */
export const skillQueries = {
  list: (cwd?: string, sessionType: SessionType = "standard", provider?: string) =>
    queryOptions({
      queryKey: ["skills", cwd ?? null, sessionType, provider ?? null] as const,
      queryFn: () => listSkills({ data: { cwd, sessionType, provider } }),
      staleTime: Infinity,
    }),
};
