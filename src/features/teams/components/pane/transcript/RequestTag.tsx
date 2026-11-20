import { Check } from "lucide-react";
import { RunningIndicator } from "@/shared/ui/running-indicator";
import type { TeamRequestState } from "./transcriptRows";

/** Whether the lead's question still needs the user's reply, or how it was settled. */
export function RequestTag({ state }: { state: TeamRequestState }) {
  return state === "pending" ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-amber-500/10 py-px pr-2 pl-0.5 text-2xs font-medium text-amber-700 dark:text-amber-400">
      <RunningIndicator waiting className="size-3.5" />
      Needs your reply
    </span>
  ) : (
    <span
      className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground"
      title={
        state === "answered"
          ? "The lead got this answer another way, so it no longer needs you."
          : undefined
      }
    >
      <Check className="size-3" />
      {state === "answered" ? "Answered" : "Replied"}
    </span>
  );
}
