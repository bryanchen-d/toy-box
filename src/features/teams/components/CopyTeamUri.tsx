import { useState } from "react";
import { Check, Link2, TriangleAlert } from "lucide-react";
import { teamUri, type TeamReferenceTarget } from "@teams/model/references";
import { Button } from "@/shared/ui/button";
import { DropdownMenuItem } from "@/shared/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";

export function CopyTeamUri({
  target,
  label,
  variant = "menu",
}: {
  target: TeamReferenceTarget;
  label: string;
  variant?: "menu" | "button";
}) {
  const [result, setResult] = useState<"copied" | Error>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(teamUri(target));
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
      <Check aria-hidden />
    ) : result instanceof Error ? (
      <TriangleAlert aria-hidden className="text-destructive" />
    ) : (
      <Link2 aria-hidden />
    );
  if (variant === "menu") {
    return (
      <DropdownMenuItem aria-label={text} closeOnClick={false} onClick={() => void copy()}>
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
          <Button variant="ghost" size="icon-xs" aria-label={label} onClick={() => void copy()}>
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
