import { infiniteQueryOptions, queryOptions, type InfiniteData } from "@tanstack/react-query";
import type { ClosedFindingsCursor, ClosedFindingsPage } from "./model";
import { listClosedSecurityFindings, listOpenSecurityFindings } from "./server/functions";

/** Which sessions' closed findings a list shows: some, such as a team's agents, or all. */
export type ClosedFindingsScope = readonly string[] | "all";
export type ClosedFindingsData = InfiniteData<ClosedFindingsPage, ClosedFindingsCursor | undefined>;

export const securityQueries = {
  all: () => ["security", "findings"] as const,
  openKey: () => [...securityQueries.all(), "open"] as const,
  closedKey: () => [...securityQueries.all(), "closed"] as const,

  /** Every open finding: few, since each holds its session until the user closes it. */
  open: () =>
    queryOptions({
      queryKey: securityQueries.openKey(),
      queryFn: () => listOpenSecurityFindings(),
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),

  /** The closed record, a page at a time, since it only grows. */
  closed: (sessionIds?: readonly string[]) => {
    const scope: ClosedFindingsScope = sessionIds ? [...sessionIds].sort() : "all";
    return infiniteQueryOptions({
      queryKey: [...securityQueries.closedKey(), scope] as const,
      queryFn: ({ pageParam }) =>
        listClosedSecurityFindings({
          data: { sessionIds: scope === "all" ? undefined : [...scope], before: pageParam },
        }),
      initialPageParam: undefined as ClosedFindingsCursor | undefined,
      getNextPageParam: (page) => page.next,
      staleTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    });
  },
};
