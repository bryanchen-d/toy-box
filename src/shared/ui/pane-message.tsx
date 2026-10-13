import type { ReactNode } from "react";
import { AlertTriangle, Loader2, type LucideIcon } from "lucide-react";

/**
 * What a pane shows in place of its content: a centered title and detail, with any actions
 * below. A loading message spins; any other shows its icon, or else a warning.
 */
export function PaneMessage({
  title,
  detail,
  loading = false,
  icon: Icon,
  children,
}: {
  title: string;
  detail: string;
  loading?: boolean;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center bg-background p-8 text-center">
      <div className="flex max-w-md flex-col items-center gap-3">
        {loading ? (
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        ) : Icon ? (
          <Icon className="size-5 text-muted-foreground" />
        ) : (
          <AlertTriangle className="size-5 text-destructive" />
        )}
        <div>
          <h2 className="font-medium">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
        </div>
        {children}
      </div>
    </div>
  );
}
