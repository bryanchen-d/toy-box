import type { QueryClient } from "@tanstack/react-query";
import type { WorkspaceEvent } from "@workspace/model/events";
import type { SecurityFinding } from "./model";
import { securityQueries, type ClosedFindingsData, type ClosedFindingsScope } from "./queries";

/** Move a changed finding between the open list and every loaded closed list it belongs to. */
export function applySecurityFindingEvent(queryClient: QueryClient, event: WorkspaceEvent): void {
  if (event.type !== "security.finding.upserted") return;
  const { finding } = event;
  queryClient.setQueryData<SecurityFinding[]>(
    securityQueries.openKey(),
    (open) => open && withOpenFinding(open, finding),
  );
  for (const [queryKey, data] of queryClient.getQueriesData<ClosedFindingsData>({
    queryKey: securityQueries.closedKey(),
  })) {
    const scope = queryKey[3] as ClosedFindingsScope;
    if (data) queryClient.setQueryData(queryKey, withClosedFinding(data, finding, scope));
  }
  // Replace an overlapping snapshot with a read started after the committed change.
  void queryClient.refetchQueries({
    queryKey: securityQueries.all(),
    predicate: ({ state }) => state.fetchStatus === "fetching",
  });
}

export function invalidateSecurityFindingQueries(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: securityQueries.all() });
}

function withOpenFinding(open: SecurityFinding[], finding: SecurityFinding): SecurityFinding[] {
  const others = open.filter(({ id }) => id !== finding.id);
  return finding.closed
    ? others
    : [...others, finding].sort(
        (left, right) =>
          right.detectedAt.localeCompare(left.detectedAt) || left.id.localeCompare(right.id),
      );
}

function withClosedFinding(
  data: ClosedFindingsData,
  finding: SecurityFinding,
  scope: ClosedFindingsScope,
): ClosedFindingsData {
  const listed = data.pages.some((page) => page.findings.some(({ id }) => id === finding.id));
  if (listed) {
    return {
      ...data,
      pages: data.pages.map((page) => ({
        ...page,
        findings: finding.closed
          ? page.findings.map((listedFinding) =>
              listedFinding.id === finding.id ? finding : listedFinding,
            )
          : page.findings.filter(({ id }) => id !== finding.id),
      })),
    };
  }
  const [first, ...rest] = data.pages;
  if (!finding.closed || !first || (scope !== "all" && !scope.includes(finding.sessionId)))
    return data;
  // A finding closes now, so one this list hasn't seen is its newest.
  return { ...data, pages: [{ ...first, findings: [finding, ...first.findings] }, ...rest] };
}
