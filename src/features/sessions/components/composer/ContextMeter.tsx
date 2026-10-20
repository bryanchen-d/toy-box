import type { ComponentProps } from "react";
import type { ContextUsage } from "@sessions/model";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { cn } from "@/shared/utils";

const TOKEN_COUNT_FORMATTER = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 0,
});

/** How full the model's context window is: a quiet ring that appears once the window is half
 *  full and warms as it fills. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const fraction = Math.min(usage.tokens / usage.tokenWindow, 1);
  if (fraction <= 0.5) return null;
  const percent = Math.round(fraction * 100);
  const tone =
    fraction >= 0.9
      ? "text-destructive"
      : fraction >= 0.7
        ? "text-accent"
        : "text-muted-foreground";
  const remaining = Math.max(usage.tokenWindow - usage.tokens, 0);

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        aria-label={`Context window ${percent}% full`}
        render={
          <button
            type="button"
            className="grid size-7 shrink-0 place-items-center rounded-md transition-colors hover:bg-muted/50"
          />
        }
      >
        <ContextRing fraction={fraction} className={cn("size-4", tone)} />
      </PopoverTrigger>
      <PopoverContent side="top" className="flex w-auto items-center gap-2 p-2 pr-3">
        <div className="relative grid size-13 shrink-0 place-items-center">
          <ContextRing
            fraction={fraction}
            strokeWidth={2}
            className={cn("absolute inset-0 size-full", tone)}
          />
          <span className="text-2xs font-medium tabular-nums">{percent}%</span>
        </div>
        <div className="grid gap-1 text-xs tabular-nums">
          <div>
            {TOKEN_COUNT_FORMATTER.format(usage.tokens)} of{" "}
            {TOKEN_COUNT_FORMATTER.format(usage.tokenWindow)} tokens
          </div>
          <div className="text-muted-foreground">
            {TOKEN_COUNT_FORMATTER.format(remaining)} tokens left
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ContextRing({
  fraction,
  ...props
}: Omit<ComponentProps<"svg">, "ref" | "children"> & { fraction: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      aria-hidden
      {...props}
    >
      <circle cx={12} cy={12} r={9} opacity={0.25} />
      <circle
        cx={12}
        cy={12}
        r={9}
        pathLength={100}
        strokeDasharray={`${fraction * 100} 100`}
        strokeLinecap="round"
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}
