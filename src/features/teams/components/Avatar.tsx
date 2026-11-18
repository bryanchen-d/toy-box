import type { ReactNode } from "react";
import type { Avatar as AvatarValue } from "@teams/model";
import { cn } from "@/shared/utils";

/** The shared frame and vector mark for team and agent identities. */
export function Avatar({
  avatar,
  fallback,
  className,
}: {
  avatar?: AvatarValue;
  fallback: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden",
        !avatar && "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
        className,
      )}
      style={
        avatar
          ? { backgroundColor: avatar.color, color: `contrast-color(${avatar.color})` }
          : undefined
      }
      aria-hidden
    >
      {avatar ? (
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
        fallback
      )}
    </span>
  );
}
