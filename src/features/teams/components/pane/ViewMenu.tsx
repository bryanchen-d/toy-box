import type { LucideIcon } from "lucide-react";
import { Button } from "@/shared/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

export type ViewOption<View extends string> = { value: View; label: string; Icon: LucideIcon };

/** Chooses which items a list shows; the trigger shows the current view's icon. */
export function ViewMenu<View extends string>({
  name,
  views,
  view,
  onViewChange,
}: {
  /** What the menu chooses, such as "Message view", which the trigger's label leads with. */
  name: string;
  views: readonly ViewOption<View>[];
  view: View;
  onViewChange: (view: View) => void;
}) {
  const { label, Icon } = views.find(({ value }) => value === view)!;
  const triggerLabel = `${name}: ${label}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={triggerLabel}
            title={triggerLabel}
          />
        }
      >
        <Icon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" finalFocus={false}>
        <DropdownMenuRadioGroup value={view} onValueChange={onViewChange}>
          {views.map(({ value, label, Icon: OptionIcon }) => (
            <DropdownMenuRadioItem key={value} value={value} className="gap-2 text-xs">
              <OptionIcon className="size-3.5 text-muted-foreground" />
              {label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
