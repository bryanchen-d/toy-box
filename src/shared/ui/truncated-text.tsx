import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";

/** One line of text, cut off with an ellipsis when its container is too narrow. Hovering a cut-off
 *  line shows all of it; a line that fits shows nothing more. */
export function TruncatedText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Tooltip
      onOpenChange={(open, { trigger, cancel }) => {
        if (open && trigger && trigger.scrollWidth <= trigger.clientWidth) cancel();
      }}
    >
      <TooltipTrigger render={<span className={cn("block truncate", className)} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent sideOffset={4} className="max-w-sm break-words">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
