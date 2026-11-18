import { UserRoundX } from "lucide-react";
import type { TeamAgentIdentity } from "@teams/model";
import { cn } from "@/shared/utils";
import { Avatar } from "../Avatar";

/** Render an agent-authored vector mark inside the shared avatar frame, or mark a removed agent. */
export function AgentAvatar({
  agent: { name, avatar, deleted },
  className,
}: {
  agent: Pick<TeamAgentIdentity, "name" | "avatar" | "deleted">;
  className?: string;
}) {
  return (
    <Avatar
      className={cn("rounded-full", deleted && "bg-muted text-muted-foreground", className)}
      avatar={deleted ? undefined : avatar}
      fallback={
        deleted ? (
          <UserRoundX className="size-[60%]" />
        ) : (
          <span className="text-[0.7em] font-bold">{name.slice(0, 1).toUpperCase()}</span>
        )
      }
    />
  );
}
