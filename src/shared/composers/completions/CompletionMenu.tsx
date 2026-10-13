import { Fragment, type ReactNode } from "react";
import { FilePenLine } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { cn } from "@/shared/utils";
import type { CompletionItem, Completions } from "./useCompletions";

/** The open completion's items above the input, each with an optional host icon and extras. */
export function CompletionMenu<Item extends CompletionItem>({
  completions,
  label,
  icon,
  trailing,
  edit,
}: {
  completions: Completions<Item>;
  label: string;
  icon?: (item: Item) => ReactNode;
  /** Metadata shown after the item's text. */
  trailing?: (item: Item) => ReactNode;
  /** Edits what an item names, when it can be edited. */
  edit?: (item: Item) => (() => void) | undefined;
}) {
  const { source, items, pending, error, activeIndex, menuProps, itemProps } = completions;
  if (!source) return null;
  return (
    <div
      {...menuProps}
      aria-label={label}
      aria-busy={pending || undefined}
      className="absolute bottom-full left-0 z-30 mb-2 max-h-72 w-full overflow-y-auto rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-lg @sm:w-96"
    >
      {items.length === 0 && (
        <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
          {pending ? "Searching..." : <em>{source.empty}</em>}
        </p>
      )}
      {items.map((item, index) => {
        const editItem = edit?.(item);
        return (
          <Fragment key={`${item.group ?? ""}:${item.value}`}>
            {item.group && item.group !== items[index - 1]?.group && (
              <div className="px-2 pt-1 pb-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                {item.group}
              </div>
            )}
            <div
              {...itemProps(index)}
              className={cn(
                "flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
                index === activeIndex && "bg-accent/50 text-accent-foreground",
              )}
            >
              {icon?.(item)}
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {item.label}
                  {item.detail && <span className="ms-1.5 text-xs opacity-70">{item.detail}</span>}
                </span>
                {item.description && (
                  <ScrollableFade className="whitespace-nowrap text-xs opacity-70">
                    <span className="shrink-0">{item.description}</span>
                  </ScrollableFade>
                )}
              </span>
              {trailing?.(item)}
              {editItem && <EditItemButton label={`Edit ${item.label}`} onClick={editItem} />}
            </div>
          </Fragment>
        );
      })}
      {error && (
        <p role="alert" className="border-t px-2 py-2 text-2xs text-destructive">
          {error.message}
        </p>
      )}
    </div>
  );
}

/** It keeps the input's focus and never accepts its item. */
function EditItemButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label={label}
      title={label}
      className="shrink-0 text-muted-foreground hover:text-foreground"
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.button === 0) event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      <FilePenLine aria-hidden="true" />
    </Button>
  );
}
