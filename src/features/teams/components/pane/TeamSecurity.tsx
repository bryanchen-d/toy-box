import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, ShieldAlert } from "lucide-react";
import type { TeamAgent } from "@teams/model";
import { ClosedSecurityFindings } from "@security/components/ClosedSecurityFindings";
import { SecurityFindingCard } from "@security/components/SecurityFindingCard";
import { securityQueries } from "@security/queries";
import { sessionQueries } from "@sessions/queries";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { cn } from "@/shared/utils";
import { TeamPanelHeader } from "./TeamPanelHeader";

/**
 * Content that tried to steer this team's agents, or any session's: open findings first, then
 * the closed record, which loads only when the user unfolds it.
 */
export function TeamSecurity({ agents }: { agents: readonly TeamAgent[] }) {
  const { data: open = [] } = useQuery(securityQueries.open());
  const { data: sessionTitles } = useQuery({
    ...sessionQueries.state(),
    select: (state) => new Map(state.sessions.map(({ id, title }) => [id, title])),
  });
  const { openSession } = useWorkspaceSurface();
  const [scope, setScope] = useState<"team" | "all">("team");
  const [showClosed, setShowClosed] = useState(false);
  const agentNames = new Map(agents.map(({ id, name }) => [id, name]));
  const shown = scope === "team" ? open.filter(({ sessionId }) => agentNames.has(sessionId)) : open;
  const elsewhere = open.filter(({ sessionId }) => !agentNames.has(sessionId)).length;
  const where = (sessionId: string) => agentNames.get(sessionId) ?? sessionTitles?.get(sessionId);

  return (
    <section aria-label="Security" className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <TeamPanelHeader icon={ShieldAlert} title="Security">
        <div role="group" aria-label="Findings to show" className="ml-auto flex gap-1">
          <Button
            type="button"
            size="xs"
            variant={scope === "team" ? "secondary" : "ghost"}
            aria-pressed={scope === "team"}
            onClick={() => setScope("team")}
          >
            This team
          </Button>
          <Button
            type="button"
            size="xs"
            variant={scope === "all" ? "secondary" : "ghost"}
            aria-pressed={scope === "all"}
            onClick={() => setScope("all")}
          >
            All
            {elsewhere > 0 && (
              <Badge variant="count" aria-label={`${elsewhere} open elsewhere`}>
                {elsewhere}
              </Badge>
            )}
          </Button>
        </div>
      </TeamPanelHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {shown.length > 0 ? (
          <div role="list" aria-label="Open findings" className="space-y-3">
            {shown.map((finding) => (
              <SecurityFindingCard
                key={finding.id}
                finding={finding}
                where={where(finding.sessionId)}
                onSessionOpen={openSession && (() => openSession(finding.sessionId))}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">
            {scope === "team" ? "No open findings for this team." : "No open findings."}
          </p>
        )}
        <div className="space-y-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="-ml-2 text-muted-foreground"
            aria-expanded={showClosed}
            onClick={() => setShowClosed((shown) => !shown)}
          >
            <ChevronRight
              aria-hidden
              className={cn("transition-transform", showClosed && "rotate-90")}
            />
            Closed
          </Button>
          {showClosed && (
            <ClosedSecurityFindings
              sessionIds={scope === "team" ? agents.map(({ id }) => id) : undefined}
              where={where}
              onSessionOpen={openSession}
            />
          )}
        </div>
      </div>
    </section>
  );
}
