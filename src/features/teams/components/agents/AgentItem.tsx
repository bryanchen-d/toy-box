import type { ReactNode } from "react";
import type { TeamAgent } from "@teams/model";
import type { TeamAgentPresence } from "@teams/model/presence";
import { SessionPreview, useSessionPreview } from "@sessions/components/SessionPreview";
import { useTeamPane } from "../pane/TeamPaneContext";
import { ClockTime } from "@/shared/ui/clock-time";
import { RunningIndicator } from "@/shared/ui/running-indicator";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { cn } from "@/shared/utils";
import { AgentAvatar } from "./AgentAvatar";

/** One agent in a Team. The ring around its avatar shows whether it's working or waiting, and the
 *  line beneath its name says on what, or what it's for while idle. */
export function AgentItem({
  agent,
  action,
  role = "listitem",
  showDetail = true,
}: {
  agent: TeamAgent;
  action?: ReactNode;
  role?: "listitem" | "presentation";
  showDetail?: boolean;
}) {
  const preview = useSessionPreview();
  const presence = useTeamPane().presence[agent.id] ?? { state: "idle" };
  const detail = showDetail ? presenceDetail(presence, agent.role) : undefined;

  return (
    <div role={role} className="flex min-w-0 items-center gap-2.5 py-1 text-left">
      <SessionPreview sessionId={agent.id} side="left" sideOffset={10} {...preview}>
        <button
          type="button"
          aria-label={`Preview ${agent.name}'s session`}
          title={`Preview ${agent.name}'s session`}
          onMouseEnter={preview.onMouseEnter}
          onMouseLeave={preview.onMouseLeave}
          className="relative shrink-0 rounded-full"
        >
          <AgentAvatar agent={agent} className="size-6" />
          {presence.state !== "idle" && (
            <RunningIndicator
              waiting={presence.state === "waiting"}
              strokeWidth={1.25}
              className="pointer-events-none absolute -top-1.75 -left-1.75 size-9.5 text-muted-foreground"
            />
          )}
        </button>
      </SessionPreview>
      <span className="flex min-w-0 flex-1 flex-col">
        <ScrollableFade className="whitespace-nowrap text-xs">
          <span className="shrink-0">{agent.name}</span>
        </ScrollableFade>
        {detail && (
          <ScrollableFade
            className={cn(
              "whitespace-nowrap text-2xs",
              presence.state === "waiting"
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            <span className="shrink-0">{detail}</span>
          </ScrollableFade>
        )}
      </span>
      {action}
    </div>
  );
}

function presenceDetail(presence: TeamAgentPresence, role?: string): ReactNode {
  switch (presence.state) {
    case "working":
      return presence.text ?? "Working";
    case "waiting":
      return presence.wakeAt ? (
        <>
          Waiting for {presence.text} · checks back at <ClockTime date={presence.wakeAt} />
        </>
      ) : (
        `Waiting for ${presence.text}`
      );
    case "idle":
      return role;
  }
}
