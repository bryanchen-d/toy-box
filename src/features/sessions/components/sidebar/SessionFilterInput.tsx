import { Filter, X } from "lucide-react";
import { useProviders } from "@providers/useProviders";
import type { SessionFilters } from "@sessions/components/sidebar/sessionFilters";
import { Input } from "@/shared/ui/input";
import { cn } from "@/shared/utils";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";

/** Narrows the session list by text, model provider, and external origin. */
export function SessionFilterInput({
  filter,
  onFilterChange,
}: {
  filter: SessionFilters;
  onFilterChange: (value: SessionFilters) => void;
}) {
  const { providers, hasModels } = useProviders();
  const isFiltering = filter.hiddenProviders.length > 0 || !filter.showExternalSessions;

  return (
    <div className="relative" suppressHydrationWarning>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={!hasModels}
          render={
            <button
              className={cn(
                "absolute left-2 top-1/2 -translate-y-1/2 flex items-center hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
                isFiltering ? "text-foreground" : "text-muted-foreground",
              )}
              aria-label={isFiltering ? "Filter sessions (some hidden)" : "Filter sessions"}
              suppressHydrationWarning
            />
          }
        >
          <Filter className="h-4 w-4" />
          {isFiltering && (
            <span className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Model Providers
            </DropdownMenuLabel>
            {providers
              .filter((provider) => provider.installed && provider.enabled)
              .map(({ id, name }) => (
                <DropdownMenuCheckboxItem
                  key={id}
                  checked={!filter.hiddenProviders.includes(id)}
                  onCheckedChange={(checked) =>
                    onFilterChange({
                      ...filter,
                      hiddenProviders: checked
                        ? filter.hiddenProviders.filter((provider) => provider !== id)
                        : [...filter.hiddenProviders, id],
                    })
                  }
                >
                  {name}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={filter.showExternalSessions}
            onCheckedChange={(checked) =>
              onFilterChange({ ...filter, showExternalSessions: checked })
            }
          >
            Show external sessions
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Input
        disabled={!hasModels}
        value={filter.query}
        onChange={(e) => onFilterChange({ ...filter, query: e.target.value })}
        placeholder="Filter sessions"
        className="h-8 pl-8 pr-8"
      />
      {filter.query && (
        <button
          disabled={!hasModels}
          onClick={() => onFilterChange({ ...filter, query: "" })}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          aria-label="Clear filter"
          suppressHydrationWarning
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
