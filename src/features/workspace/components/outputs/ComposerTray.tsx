// The composer tray docks to the input. Its first row holds what the owner produced: artifacts in
// the owner's order, a checklist, and the owner's extra output. Once any output exists, empty
// artifact and checklist slots preserve that row's shape. Owners stack anything else, such as
// queued messages, below it, and the tray hides when nothing renders.

import { useState, type ReactNode } from "react";
import { defaultFilter } from "cmdk";
import { Archive, Files, Loader2, Pin, PinOff, SlidersHorizontal } from "lucide-react";
import { useEditorDisplay } from "@files/components/editor/kinds";
import { workspaceFileId, type WorkspaceFile } from "@files/model";
import { createFileServeUrl } from "@files/model/paths";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { createEditorPaneId } from "@workspace/model/panes";
import type { ChecklistItem } from "@/shared/ui/checklist";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/shared/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/shared/ui/popover";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/shared/ui/preview-card";
import { RelativeTime } from "@/shared/ui/relative-time";
import { ScrollableFade } from "@/shared/ui/scrollable-fade";
import { cn } from "@/shared/utils";
import {
  ArtifactPill,
  emptyOutputPillClassName,
  outputPillClassName,
  useArtifactState,
} from "./ArtifactPill";
import { ChecklistPopup } from "./ChecklistPopup";
import { PagePreview } from "./PagePreview";

// The first artifact joins the row once the composer has room; two more follow when wide.
const INLINE_ARTIFACT_CLASS_NAMES = ["@max-md:hidden", "@max-2xl:hidden", "@max-2xl:hidden"];

/** A file its owner presents as output. */
type ComposerArtifact = {
  file: WorkspaceFile;
  /** Shown instead of the file's own name. */
  label?: string;
  /** When its owner last updated or shared it, in epoch milliseconds. */
  time: number;
  pinned?: boolean;
};

export function ComposerTray({
  artifacts,
  artifactTimeLabel,
  checklist,
  checklistLabel,
  checklistHeaderDetail,
  extraOutput,
  onOpenArtifact,
  onArchiveArtifact,
  onPinArtifact,
  artifactActionsDisabled,
  onManageArtifacts,
  children,
}: {
  /** In the owner's order, such as newest first. */
  artifacts: readonly ComposerArtifact[];
  /** What an artifact's time means in its preview, such as "Updated" or "Shared". */
  artifactTimeLabel: string;
  checklist: readonly ChecklistItem[];
  checklistLabel: string;
  checklistHeaderDetail?: ReactNode;
  /** The owner's own output after the checklist, such as changed files or a preview. */
  extraOutput?: ReactNode;
  /** Opens an artifact that its owner doesn't publish. By default, focusing its editor pane brings
   *  a published artifact forward. */
  onOpenArtifact?: (file: WorkspaceFile) => void;
  /** Files an artifact away from the tray, offered beside each one in the full list. */
  onArchiveArtifact?: (file: WorkspaceFile) => void;
  onPinArtifact?: (file: WorkspaceFile, pinned: boolean) => void;
  artifactActionsDisabled?: boolean;
  /** Opens the owner's own surface for arranging its artifacts, offered below the full list. */
  onManageArtifacts?: () => void;
  children?: ReactNode;
}) {
  const { focusedPaneAtom } = useWorkspaceSurface();
  const hasOutputs = artifacts.length > 0 || checklist.length > 0 || Boolean(extraOutput);

  const openArtifact = ({ file }: ComposerArtifact) =>
    onOpenArtifact ? onOpenArtifact(file) : focusedPaneAtom.set(createEditorPaneId(file));

  return (
    <div className="mx-2 rounded-t-lg border border-b-0 bg-secondary-background p-1 empty:hidden">
      {hasOutputs && (
        <div className="flex items-center gap-1.5 p-0.5 not-last:mb-1 not-last:border-b not-last:pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {artifacts.slice(0, INLINE_ARTIFACT_CLASS_NAMES.length).map((artifact, index) => (
              <ArtifactPeek
                key={workspaceFileId(artifact.file)}
                className={INLINE_ARTIFACT_CLASS_NAMES[index]}
                artifact={artifact}
                timeLabel={artifactTimeLabel}
                onOpen={() => openArtifact(artifact)}
              />
            ))}
            {artifacts.length > 0 ? (
              <ArtifactList
                artifacts={artifacts}
                onOpen={openArtifact}
                onArchive={onArchiveArtifact && (({ file }) => onArchiveArtifact(file))}
                onPin={onPinArtifact && (({ file, pinned }) => onPinArtifact(file, !pinned))}
                actionsDisabled={artifactActionsDisabled}
                onManage={onManageArtifacts}
              />
            ) : (
              <span className={emptyOutputPillClassName}>
                <Files className="size-3.5 shrink-0" />0 artifacts
              </span>
            )}
          </div>
          <ChecklistPopup
            items={checklist}
            label={checklistLabel}
            headerDetail={checklistHeaderDetail}
          />
          {extraOutput}
        </div>
      )}
      {children}
    </div>
  );
}

/** An inline artifact that opens on click and, on desktop, previews on hover. */
function ArtifactPeek({
  className,
  artifact,
  timeLabel,
  onOpen,
}: {
  className?: string;
  artifact: ComposerArtifact;
  timeLabel: string;
  onOpen: () => void;
}) {
  const { file, label, time } = artifact;
  const preview = /\.svg$/i.test(file.path)
    ? "svg"
    : /\.html?$/i.test(file.path)
      ? "html"
      : undefined;
  // Inline pills share the tray's row, so each caps its width.
  const pill = (
    <ArtifactPill
      file={file}
      label={label}
      pinned={artifact.pinned}
      onClick={onOpen}
      className={cn("max-w-56", className)}
    />
  );
  if (!preview) return pill;

  const previewUrl = `${createFileServeUrl(file)}?v=${time}`;

  return (
    <PreviewCard>
      <PreviewCardTrigger delay={400} render={pill} />
      <PreviewCardContent side="top" align="start" sideOffset={8} className="hidden p-2 md:block">
        {preview === "svg" ? (
          <img
            src={previewUrl}
            alt=""
            className="aspect-video w-full rounded-md border bg-muted/40 object-contain"
          />
        ) : (
          <PagePreview src={previewUrl} title={`Preview ${file.path}`} />
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {timeLabel} <RelativeTime date={new Date(time)} />
        </p>
      </PreviewCardContent>
    </PreviewCard>
  );
}

/** Every artifact, filterable. Pin controls stay reachable even when every artifact fits inline. */
function ArtifactList({
  artifacts,
  onOpen,
  onArchive,
  onPin,
  actionsDisabled,
  onManage,
}: {
  artifacts: readonly ComposerArtifact[];
  onOpen: (artifact: ComposerArtifact) => void;
  onArchive?: (artifact: ComposerArtifact) => void;
  onPin?: (artifact: ComposerArtifact) => void;
  actionsDisabled?: boolean;
  onManage?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const count = artifacts.length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="All artifacts"
        className={cn(
          outputPillClassName,
          !onPin &&
            (count === 1
              ? "@md:hidden"
              : count <= INLINE_ARTIFACT_CLASS_NAMES.length && "@2xl:hidden"),
        )}
        render={<button type="button" />}
      >
        <Files className={cn("size-3.5 shrink-0", !onPin && "@md:hidden")} />
        <span className={cn(!onPin && "@md:hidden")}>
          {count} {count === 1 ? "artifact" : "artifacts"}
        </span>
        {!onPin && <span className="@max-md:hidden @2xl:hidden">+{count - 1}</span>}
        {!onPin && (
          <span className="@max-2xl:hidden">+{count - INLINE_ARTIFACT_CLASS_NAMES.length}</span>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-0">
        <Command filter={filterByKeywords}>
          <CommandInput placeholder="Filter artifacts" />
          <CommandList>
            <CommandEmpty className="py-6 text-center text-sm text-muted-foreground italic">
              No matching artifacts
            </CommandEmpty>
            {/* cmdk sorts an item's wrapper only within a group. */}
            <CommandGroup className="p-0">
              {artifacts.map((artifact) => (
                <ArtifactListItem
                  key={workspaceFileId(artifact.file)}
                  artifact={artifact}
                  onSelect={() => {
                    setOpen(false);
                    onOpen(artifact);
                  }}
                  onArchive={onArchive && (() => onArchive(artifact))}
                  onPin={onPin && (() => onPin(artifact))}
                  actionsDisabled={actionsDisabled}
                />
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
        {onManage && (
          <button
            type="button"
            className="flex w-full items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground outline-none hover:bg-accent/40 hover:text-foreground focus-visible:bg-accent/40"
            onClick={() => {
              setOpen(false);
              onManage();
            }}
          >
            <SlidersHorizontal className="size-3.5" />
            Manage artifacts
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Items select by their unique file ID, which embeds a session ID, so match only what they show.
function filterByKeywords(_value: string, search: string, keywords?: string[]) {
  return defaultFilter("", search, keywords);
}

function ArtifactListItem({
  artifact,
  onSelect,
  onArchive,
  onPin,
  actionsDisabled,
}: {
  artifact: ComposerArtifact;
  onSelect: () => void;
  onArchive?: () => void;
  onPin?: () => void;
  actionsDisabled?: boolean;
}) {
  const { file, time } = artifact;
  const { name, Icon } = useEditorDisplay(file);
  const { open, busy } = useArtifactState(file);
  const label = artifact.label ?? name;
  const item = (
    <CommandItem
      value={workspaceFileId(file)}
      keywords={[label, file.path]}
      onSelect={onSelect}
      className={cn(onArchive && onPin ? "pe-16" : (onArchive || onPin) && "pe-9")}
    >
      {busy ? <Loader2 className="animate-spin" /> : <Icon />}
      <ScrollableFade
        className={cn("flex-1 whitespace-nowrap", open && "font-medium text-foreground")}
      >
        <span className="shrink-0">{label}</span>
      </ScrollableFade>
      {artifact.pinned && <Pin className="size-3 shrink-0" role="img" aria-label="Pinned" />}
      <RelativeTime
        className="ms-auto shrink-0 text-xs text-muted-foreground"
        date={new Date(time)}
      />
    </CommandItem>
  );
  if (!onArchive && !onPin) return item;

  // A sibling of the option rather than inside it, so archiving never also selects it. The wrapper
  // hides with the option when filtering leaves it out.
  return (
    <div className="group/artifact relative [&:not(:has([cmdk-item]))]:hidden">
      {item}
      <div className="absolute end-1.5 top-1/2 flex -translate-y-1/2 opacity-0 group-hover/artifact:opacity-100 group-has-data-[selected=true]/artifact:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        {onPin && (
          <button
            type="button"
            aria-label={`${artifact.pinned ? "Unpin" : "Pin"} ${label}`}
            title={artifact.pinned ? "Unpin" : "Pin"}
            disabled={actionsDisabled}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={onPin}
          >
            {artifact.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
        )}
        {onArchive && (
          <button
            type="button"
            aria-label={`Archive ${label}`}
            title="Archive"
            disabled={actionsDisabled}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            onClick={onArchive}
          >
            <Archive className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
