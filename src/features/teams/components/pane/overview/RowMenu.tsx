import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";

/** An overview row's "⋯" menu. A row without actions, such as the lead's, keeps the same shape
 *  with its menu disabled. */
export function RowMenu({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={!children}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Actions for ${name}`}
            title={`Actions for ${name}`}
          />
        }
      >
        <MoreHorizontal />
      </DropdownMenuTrigger>
      {children && <DropdownMenuContent align="end">{children}</DropdownMenuContent>}
    </DropdownMenu>
  );
}
