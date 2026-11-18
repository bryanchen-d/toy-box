import { Children } from "react";
import { cn } from "@/shared/utils";
import { SidebarList } from "./SidebarList";
import { SidebarSection, type SidebarSectionProps } from "./SidebarSection";

/** A sidebar section whose body is a scrolling list of its items. */
export function SidebarPanel({
  emptyMessage,
  fill = false,
  children,
  ...section
}: Omit<SidebarSectionProps, "count"> & { emptyMessage?: string }) {
  return (
    <SidebarSection {...section} fill={fill} count={Children.toArray(children).length}>
      <SidebarList
        rootClassName={fill ? "min-h-0 flex-1" : undefined}
        className={cn("px-3 py-2", !fill && "h-auto max-h-56")}
        emptyState={
          emptyMessage && <p className="px-2 py-3 text-xs text-muted-foreground">{emptyMessage}</p>
        }
      >
        {children}
      </SidebarList>
    </SidebarSection>
  );
}
