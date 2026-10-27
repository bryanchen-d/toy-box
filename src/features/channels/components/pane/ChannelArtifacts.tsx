import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Reorder, useDragControls } from "motion/react";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ArrowUpToLine,
  Files,
  GripVertical,
  Loader2,
  Search,
  X,
} from "lucide-react";
import type { ArrangeChannelArtifactsInput, ChannelArtifact } from "@channels/model";
import { channelMutations } from "@channels/mutations";
import { useEditorDisplay } from "@files/components/editor/kinds";
import { useArtifactState } from "@workspace/components/outputs/ArtifactPill";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/ui/dropdown-menu";
import { Input } from "@/shared/ui/input";
import { RelativeTime } from "@/shared/ui/relative-time";
import { cn } from "@/shared/utils";
import { useChannelPane } from "./ChannelPaneContext";
import { RowMenu } from "./overview/RowMenu";

/** Shared artifacts appear in the composer tray; archived ones are filed away from it. */
type Shelf = "shared" | "archived";

const SORTS: {
  label: string;
  compare: (left: ChannelArtifact, right: ChannelArtifact) => number;
}[] = [
  { label: "Newest first", compare: (left, right) => right.sharedAt.localeCompare(left.sharedAt) },
  { label: "Oldest first", compare: (left, right) => left.sharedAt.localeCompare(right.sharedAt) },
  { label: "Name", compare: (left, right) => left.title.localeCompare(right.title) },
];

/**
 * Every artifact shared in the Channel, where the user arranges what the composer tray shows:
 * beside chat, or in its place in a narrow pane. Artifacts open, reorder by dragging or moving,
 * sort once by a rule, and archive or restore, one at a time or as a selection.
 */
export function ChannelArtifacts({
  channelId,
  artifacts,
  onClose,
}: {
  channelId: string;
  /** In the user's arrangement, archived or not. */
  artifacts: ChannelArtifact[];
  onClose: () => void;
}) {
  const { openArtifact } = useChannelPane();
  const { mutate: arrange } = useMutation(channelMutations.arrangeArtifacts(channelId));
  const [shelf, setShelf] = useState<Shelf>("shared");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  // A drag reorders locally until the arrangement it commits replaces these artifacts.
  const [drag, setDrag] = useState<{ from: ChannelArtifact[]; ids: string[] }>();
  const shared = artifacts.filter(({ archived }) => !archived);
  const archived = artifacts.filter(({ archived }) => archived);
  const shelved = shelf === "shared" ? shared : archived;
  // Only the Shared shelf drags.
  const ordered =
    shelf === "shared" && drag?.from === artifacts
      ? drag.ids.flatMap((id) => shared.find((artifact) => artifact.id === id) ?? [])
      : shelved;
  const search = query.trim().toLowerCase();
  const visible = search
    ? ordered.filter(({ title, file }) => `${title}\n${file.path}`.toLowerCase().includes(search))
    : ordered;
  // Actions apply only to what the reader can see selected.
  const selected = visible.filter(({ id }) => selection.has(id));
  const selectedIds = new Set(selected.map(({ id }) => id));
  const allSelected = visible.length > 0 && selected.length === visible.length;
  const canDrag = shelf === "shared" && !search;

  function arrangeSelection(
    arrangement: Omit<ArrangeChannelArtifactsInput, "channelId" | "artifactIds">,
  ) {
    arrange({ artifactIds: [...selectedIds], ...arrangement });
    setSelection(new Set());
  }

  function toggle(artifactId: string, isSelected: boolean) {
    const next = new Set(selection);
    if (isSelected) next.add(artifactId);
    else next.delete(artifactId);
    setSelection(next);
  }

  function drop(artifactId: string) {
    if (ordered.every((artifact, index) => artifact === shelved[index])) {
      setDrag(undefined);
      return;
    }
    const ids = ordered.map(({ id }) => id);
    // The optimistic arrangement supersedes the drag; clearing it once settled keeps a rollback
    // from reviving it.
    arrange(
      { artifactIds: [artifactId], beforeArtifactId: ids[ids.indexOf(artifactId) + 1] ?? null },
      { onSettled: () => setDrag(undefined) },
    );
  }

  /** Moves are relative to the whole shelf, so they mean the same while searching. */
  function moves(artifact: ChannelArtifact): ReactNode {
    const index = shared.indexOf(artifact);
    const move = (beforeArtifactId: string | null) =>
      arrange({ artifactIds: [artifact.id], beforeArtifactId });
    return (
      <>
        <DropdownMenuItem disabled={index === 0} onClick={() => move(shared[0]!.id)}>
          <ArrowUpToLine /> Move to top
        </DropdownMenuItem>
        <DropdownMenuItem disabled={index === 0} onClick={() => move(shared[index - 1]!.id)}>
          <ArrowUp /> Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={index === shared.length - 1}
          onClick={() => move(shared[index + 2]?.id ?? null)}
        >
          <ArrowDown /> Move down
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </>
    );
  }

  return (
    <section aria-label="Artifacts" className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b bg-background px-3 pr-24">
        <Files className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 truncate text-sm font-medium">Artifacts</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close artifacts"
          title="Close artifacts"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="shrink-0 space-y-2 border-b bg-background px-4 py-3">
        <div className="relative">
          <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search artifacts"
            aria-label="Search artifacts"
            className="h-8 ps-8 pe-8"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              className="absolute end-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setQuery("")}
            >
              <X className="size-4" />
            </button>
          )}
        </div>
        <div role="group" aria-label="Shelf" className="flex rounded-md bg-muted p-0.5 text-xs">
          {(
            [
              ["shared", "Shared", shared.length],
              ["archived", "Archived", archived.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={shelf === value}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-sm px-2 py-1 text-muted-foreground hover:text-foreground",
                shelf === value && "bg-background text-foreground shadow-xs",
              )}
              onClick={() => {
                setShelf(value);
                setSelection(new Set());
              }}
            >
              {label}
              <Badge variant="count">{count}</Badge>
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-10 shrink-0 items-center gap-2 border-b px-4 text-xs text-muted-foreground">
        <Checkbox
          checked={allSelected}
          disabled={visible.length === 0}
          aria-label="Select all"
          onCheckedChange={(checked) =>
            setSelection(new Set(checked ? visible.map(({ id }) => id) : []))
          }
        />
        <span className="min-w-0 flex-1 truncate">
          {selected.length > 0
            ? `${selected.length} selected`
            : `${visible.length} ${visible.length === 1 ? "artifact" : "artifacts"}`}
        </span>
        {selected.length > 0 ? (
          shelf === "shared" ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                // The selection moves before the first artifact outside it, which tops the shelf.
                disabled={selected.length === shared.length}
                onClick={() =>
                  arrangeSelection({
                    beforeArtifactId: shared.find(({ id }) => !selectedIds.has(id))?.id,
                  })
                }
              >
                <ArrowUpToLine /> Move to top
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => arrangeSelection({ archived: true })}
              >
                <Archive /> Archive
              </Button>
            </>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => arrangeSelection({ archived: false })}
            >
              <ArchiveRestore /> Restore
            </Button>
          )
        ) : (
          shelf === "shared" && (
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={shared.length < 2}
                render={<Button type="button" variant="ghost" size="xs" />}
              >
                <ArrowDownUp /> Sort
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Arrange shared artifacts by</DropdownMenuLabel>
                  {SORTS.map(({ label, compare }) => (
                    <DropdownMenuItem
                      key={label}
                      onClick={() =>
                        arrange({
                          artifactIds: [...shared].sort(compare).map(({ id }) => id),
                          beforeArtifactId: null,
                        })
                      }
                    >
                      {label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {visible.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground italic">
            {search
              ? "No matching artifacts"
              : shelf === "shared"
                ? archived.length > 0
                  ? "Every artifact is archived."
                  : "No artifacts shared yet."
                : "No archived artifacts."}
          </p>
        ) : (
          <Reorder.Group
            as="div"
            axis="y"
            values={visible.map(({ id }) => id)}
            onReorder={(ids) => setDrag({ from: artifacts, ids })}
            role="list"
            aria-label={shelf === "shared" ? "Shared artifacts" : "Archived artifacts"}
            className="flex flex-col"
          >
            {visible.map((artifact) => (
              <ArrangedArtifact
                key={artifact.id}
                id={artifact.id}
                draggable={canDrag}
                onDrop={() => drop(artifact.id)}
              >
                <Checkbox
                  checked={selection.has(artifact.id)}
                  aria-label={`Select ${artifact.title}`}
                  onCheckedChange={(checked) => toggle(artifact.id, checked)}
                />
                <ArtifactSummary artifact={artifact} onOpen={() => openArtifact(artifact.file)} />
                <RowMenu name={artifact.title}>
                  {shelf === "shared" ? (
                    <>
                      {moves(artifact)}
                      <DropdownMenuItem
                        onClick={() => arrange({ artifactIds: [artifact.id], archived: true })}
                      >
                        <Archive /> Archive
                      </DropdownMenuItem>
                    </>
                  ) : (
                    <DropdownMenuItem
                      onClick={() => arrange({ artifactIds: [artifact.id], archived: false })}
                    >
                      <ArchiveRestore /> Restore
                    </DropdownMenuItem>
                  )}
                </RowMenu>
              </ArrangedArtifact>
            ))}
          </Reorder.Group>
        )}
      </div>
    </section>
  );
}

/** A row that a grip in the gutter drags, so pressing the row itself still opens or scrolls. Its
 *  menu offers the same moves to keyboard and assistive technology users. */
function ArrangedArtifact({
  id,
  draggable,
  onDrop,
  children,
}: {
  id: string;
  draggable: boolean;
  onDrop: () => void;
  children: ReactNode;
}) {
  const controls = useDragControls();

  return (
    <Reorder.Item
      as="div"
      value={id}
      dragListener={false}
      dragControls={controls}
      onDragEnd={onDrop}
      role="listitem"
      className="group/artifact relative flex items-center gap-2 bg-panel"
    >
      {draggable && (
        <span
          aria-hidden
          className="absolute -start-4 top-1/2 flex h-8 w-4 -translate-y-1/2 cursor-grab touch-none items-center justify-center text-muted-foreground opacity-0 transition-opacity group-hover/artifact:opacity-100 active:cursor-grabbing pointer-coarse:opacity-100"
          onPointerDown={(event) => controls.start(event)}
        >
          <GripVertical className="size-3.5" />
        </span>
      )}
      {children}
    </Reorder.Item>
  );
}

/** The artifact's title, file, and share time, which open it. */
function ArtifactSummary({ artifact, onOpen }: { artifact: ChannelArtifact; onOpen: () => void }) {
  const { name, Icon } = useEditorDisplay(artifact.file);
  const { open, busy } = useArtifactState(artifact.file);

  return (
    <button
      type="button"
      title={artifact.file.path}
      aria-current={open || undefined}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/40",
        open && "bg-accent/15",
      )}
      onClick={onOpen}
    >
      {busy ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-sm", open && "font-medium")}>
          {artifact.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {name} · <RelativeTime date={artifact.sharedAt} />
        </span>
      </span>
    </button>
  );
}
