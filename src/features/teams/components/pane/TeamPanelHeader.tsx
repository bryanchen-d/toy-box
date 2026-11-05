import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** A Team panel's title row. Its end stays clear of the pane's floating actions. */
export function TeamPanelHeader({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-background px-3 pr-24">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
      {children}
    </header>
  );
}
