import { useRef, useState, type RefObject } from "react";
import { formatForDisplay, useHotkey } from "@tanstack/react-hotkeys";
import { useQuery, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer/debouncer";
import { Search } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Command, CommandInput, CommandItem, CommandList } from "@/shared/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import {
  MESSAGE_SEARCH_LIMIT,
  MESSAGE_SEARCH_QUERY_LIMIT,
  type MessageSearchMatch,
} from "./search";

type MessageSearchProps<TMatch extends MessageSearchMatch, TKey extends QueryKey> = {
  queries: (query: string) => UseQueryOptions<TMatch[], Error, TMatch[], TKey>;
  getKey: (match: TMatch) => string | number;
  getLabel: (match: TMatch) => string;
  isVisible: boolean;
  hotkeyTarget: RefObject<HTMLElement | null>;
  onSelect: (match: TMatch) => void;
  placeholder?: string;
};

export function MessageSearch<TMatch extends MessageSearchMatch, TKey extends QueryKey>({
  queries,
  getKey,
  getLabel,
  isVisible,
  hotkeyTarget,
  onSelect,
  placeholder = "Search this chat...",
}: MessageSearchProps<TMatch, TKey>) {
  const [open, setOpen] = useState(false);
  useHotkey("Mod+F", () => setOpen(true), {
    target: hotkeyTarget,
    enabled: isVisible,
    ignoreInputs: false,
  });
  return (
    <div className="flex shrink-0 justify-end border-b bg-panel px-3 py-1">
      <Popover open={open && isVisible} onOpenChange={setOpen}>
        <PopoverTrigger
          title={`Search messages (${formatForDisplay("Mod+F")})`}
          aria-keyshortcuts="Control+f Meta+f"
          render={<Button variant="ghost" size="sm" />}
        >
          <Search />
          Search messages
        </PopoverTrigger>
        <PopoverContent align="end" className="w-96 max-w-[calc(100vw-2rem)] p-0">
          {open && isVisible && (
            <SearchResults
              queries={queries}
              getKey={getKey}
              getLabel={getLabel}
              placeholder={placeholder}
              onSelect={(match) => {
                setOpen(false);
                onSelect(match);
              }}
            />
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SearchResults<TMatch extends MessageSearchMatch, TKey extends QueryKey>({
  queries,
  getKey,
  getLabel,
  placeholder,
  onSelect,
}: Omit<MessageSearchProps<TMatch, TKey>, "isVisible" | "hotkeyTarget">) {
  const inputRef = useRef<HTMLInputElement>(null);
  useHotkey("Mod+F", () => inputRef.current?.select(), {
    target: inputRef,
    ignoreInputs: false,
  });
  const [query, setQuery] = useState("");
  const text = query.trim();
  const [debouncedText] = useDebouncedValue(text, { wait: 200 });
  const { data, error, isPending, isFetching } = useQuery({
    ...queries(debouncedText),
    refetchInterval: debouncedText ? 1000 : false,
  });
  const waiting = text !== debouncedText || isPending;
  return (
    <Command shouldFilter={false} label="Search chat messages">
      <CommandInput
        ref={inputRef}
        aria-label="Search messages"
        placeholder={placeholder}
        maxLength={MESSAGE_SEARCH_QUERY_LIMIT}
        value={query}
        onValueChange={setQuery}
        autoFocus
      />
      <CommandList aria-busy={Boolean(text) && (waiting || isFetching)}>
        {!text ? (
          <p className="p-4 text-sm text-muted-foreground">Type to search this chat.</p>
        ) : waiting ? (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            Searching...
          </p>
        ) : error ? (
          <p role="alert" className="p-4 text-sm text-destructive">
            Unable to search messages: {error.message}
          </p>
        ) : data?.length ? (
          <>
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Newest matches (up to {MESSAGE_SEARCH_LIMIT})
            </p>
            {data.map((match) => (
              <CommandItem
                key={getKey(match)}
                value={String(getKey(match))}
                disabled={isFetching}
                className="mx-1 mb-1 flex-col items-start gap-1"
                onSelect={() => onSelect(match)}
              >
                <span className="text-xs capitalize text-muted-foreground">{getLabel(match)}</span>
                <span className="line-clamp-3 break-words whitespace-pre-wrap">
                  {match.before}
                  <mark className="rounded bg-accent text-accent-foreground">{match.match}</mark>
                  {match.after}
                </span>
              </CommandItem>
            ))}
          </>
        ) : (
          <p role="status" className="p-4 text-sm text-muted-foreground">
            No matching messages.
          </p>
        )}
      </CommandList>
    </Command>
  );
}
