import { Children } from "react";
import { SidebarList } from "./SidebarList";
import { SidebarSection, type SidebarSectionProps } from "./SidebarSection";

/** A sidebar section whose body is a short, scrolling list of its items. */
export function SidebarPanel({
  emptyMessage,
  children,
  ...section
}: Omit<SidebarSectionProps, "count" | "fill"> & { emptyMessage?: string }) {
  return (
    <SidebarSection {...section} count={Children.toArray(children).length}>
      <SidebarList
        className="h-auto max-h-56 px-3 py-2"
        emptyState={
          emptyMessage && <p className="px-2 py-3 text-xs text-muted-foreground">{emptyMessage}</p>
        }
      >
        {children}
      </SidebarList>
    </SidebarSection>
  );
}
