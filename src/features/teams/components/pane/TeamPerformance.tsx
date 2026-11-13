import { useState } from "react";
import { Gauge } from "lucide-react";
import type { Team } from "@teams/model";
import type { TeamAdvice as TeamAdviceItem } from "@teams/model/advice";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { TeamPanelHeader } from "./TeamPanelHeader";
import { TeamAdvice } from "./TeamAdvice";
import { TeamStats } from "./TeamStats";

type Tab = "stats" | "advice";

/** How the team works: measured activity over time, and advice for working better. */
export function TeamPerformance({
  team,
  advice,
  isVisible,
  onAskLead,
}: {
  team: Team;
  advice: readonly TeamAdviceItem[];
  isVisible: boolean;
  onAskLead: (content: string) => Promise<unknown>;
}) {
  const [tab, setTab] = useState<Tab>("stats");
  const openAdvice = advice.filter(({ status }) => status === "open").length;

  return (
    <section
      aria-label={`Performance of #${team.name}`}
      className="flex h-full min-h-0 min-w-0 flex-col bg-panel"
    >
      <TeamPanelHeader icon={Gauge} title="Performance">
        <div role="group" aria-label="Performance view" className="ml-auto flex gap-1">
          {(["stats", "advice"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={tab === value ? "secondary" : "ghost"}
              aria-pressed={tab === value}
              onClick={() => setTab(value)}
            >
              {value === "stats" ? "Stats" : "Advice"}
              {value === "advice" && openAdvice > 0 && (
                <Badge variant="count" aria-label={`${openAdvice} open`}>
                  {openAdvice}
                </Badge>
              )}
            </Button>
          ))}
        </div>
      </TeamPanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "stats" ? (
          <TeamStats teamId={team.id} isVisible={isVisible} />
        ) : (
          <TeamAdvice team={team} advice={advice} onAskLead={onAskLead} />
        )}
      </div>
    </section>
  );
}
