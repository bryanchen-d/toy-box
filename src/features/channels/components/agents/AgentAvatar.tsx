import { UserRoundX } from "lucide-react";
import type { ChannelAgentIdentity } from "@channels/model";
import { cn } from "@/shared/utils";

/** Render an agent-authored vector mark inside the shared avatar frame, or mark a removed agent. */
export function AgentAvatar({
  agent: { name, avatar, deleted },
  className,
}: {
  agent: Pick<ChannelAgentIdentity, "name" | "avatar" | "deleted">;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full",
        deleted
          ? "bg-muted text-muted-foreground"
          : !avatar && "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
        className,
      )}
      style={
        avatar
          ? { backgroundColor: avatar.color, color: `contrast-color(${avatar.color})` }
          : undefined
      }
      aria-hidden
    >
      {deleted ? (
        <UserRoundX className="size-[60%]" />
      ) : avatar ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-[64%]"
        >
          <path d={avatar.mark} />
        </svg>
      ) : (
        <span className="text-[0.7em] font-bold">{name.slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
