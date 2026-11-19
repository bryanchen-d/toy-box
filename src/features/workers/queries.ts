import { queryOptions } from "@tanstack/react-query";
import { listSubSessionHistory } from "./server/functions";

export const workerQueries = {
  /** The last week of sub sessions, refreshed while something shows it. */
  subSessionHistory: () =>
    queryOptions({
      queryKey: ["workers", "sub-session-history"] as const,
      queryFn: () => listSubSessionHistory(),
      staleTime: 0,
      refetchInterval: 15_000,
    }),
};
