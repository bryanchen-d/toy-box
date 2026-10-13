import { Copy } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

/** Copies a message's source text. */
export function CopyControl({ content }: { content: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground hover:text-foreground"
            aria-label="Copy message"
            onClick={() => void navigator.clipboard.writeText(content)}
          >
            <Copy aria-hidden />
          </Button>
        }
      />
      <TooltipContent sideOffset={4}>Copy message</TooltipContent>
    </Tooltip>
  );
}
