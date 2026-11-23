import { useState } from "react";
import { Check, Link2, TriangleAlert } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { DropdownMenuItem } from "@/shared/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";

/** Copies a raw URI to the clipboard, reporting success or failure in place. */
export function CopyUri({
  uri,
  label,
  variant = "menu",
  className,
  iconClassName,
}: {
  /** Absent while the URI is still resolving, which disables the control. */
  uri: string | undefined;
  label: string;
  variant?: "menu" | "button";
  className?: string;
  iconClassName?: string;
}) {
  const [result, setResult] = useState<"copied" | Error>();
  const copy = async () => {
    if (!uri) return;
    try {
      await navigator.clipboard.writeText(uri);
      setResult("copied");
    } catch (error) {
      console.error(`Unable to ${label.toLowerCase()}:`, error);
      setResult(error instanceof Error ? error : new Error("Clipboard unavailable."));
    }
  };
  const text =
    result === "copied"
      ? "Copied"
      : result instanceof Error
        ? `Copy failed: ${result.message}`
        : label;
  const icon =
    result === "copied" ? (
      <Check aria-hidden className={iconClassName} />
    ) : result instanceof Error ? (
      <TriangleAlert aria-hidden className={cn(iconClassName, "text-destructive")} />
    ) : (
      <Link2 aria-hidden className={iconClassName} />
    );
  if (variant === "menu") {
    return (
      <DropdownMenuItem
        aria-label={text}
        closeOnClick={false}
        disabled={!uri}
        onClick={() => void copy()}
      >
        {icon}
        <span role={result instanceof Error ? "alert" : result === "copied" ? "status" : undefined}>
          {text}
        </span>
      </DropdownMenuItem>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={className}
            aria-label={label}
            disabled={!uri}
            onClick={() => void copy()}
          >
            {icon}
            {result && (
              <span className="sr-only" role={result instanceof Error ? "alert" : "status"}>
                {text}
              </span>
            )}
          </Button>
        }
      />
      <TooltipContent sideOffset={4}>
        <span role={result instanceof Error ? "alert" : "status"}>{text}</span>
      </TooltipContent>
    </Tooltip>
  );
}
