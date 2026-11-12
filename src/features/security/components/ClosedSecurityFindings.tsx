import { useEffect, useRef } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { securityQueries } from "../queries";
import { SecurityFindingCard } from "./SecurityFindingCard";

/** The closed record, most recently closed first, loading older pages as they scroll into view. */
export function ClosedSecurityFindings({
  sessionIds,
  where,
  onSessionOpen,
}: {
  /** Only these sessions' findings, such as a team's agents; all when omitted. */
  sessionIds?: readonly string[];
  where: (sessionId: string) => string | undefined;
  onSessionOpen?: (sessionId: string) => void;
}) {
  const { data, error, hasNextPage, isFetchingNextPage, fetchNextPage } = useInfiniteQuery(
    securityQueries.closed(sessionIds),
  );
  const older = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const button = older.current;
    // After a failure, the button retries instead, so a broken read doesn't loop.
    if (!button || isFetchingNextPage || error) return;
    // A new observer reports at once, so a page too short to scroll keeps loading.
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) void fetchNextPage();
    });
    observer.observe(button);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, error, fetchNextPage]);

  const alert = error && (
    <p role="alert" className="text-xs text-destructive">
      {error.message}
    </p>
  );
  if (!data) return alert || <p className="text-sm text-muted-foreground">Loading…</p>;
  const findings = data.pages.flatMap((page) => page.findings);

  return (
    <div className="space-y-3">
      {findings.length > 0 ? (
        <div role="list" aria-label="Closed findings" className="space-y-3">
          {findings.map((finding) => (
            <SecurityFindingCard
              key={finding.id}
              finding={finding}
              where={where(finding.sessionId)}
              onSessionOpen={onSessionOpen && (() => onSessionOpen(finding.sessionId))}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">Nothing closed yet.</p>
      )}
      {alert}
      {hasNextPage && (
        <Button
          ref={older}
          type="button"
          size="sm"
          variant="ghost"
          className="w-full"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
        >
          {isFetchingNextPage && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Load older
        </Button>
      )}
    </div>
  );
}
