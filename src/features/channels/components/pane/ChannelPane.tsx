import { useRef, useState } from "react";
import { CatchBoundary } from "@tanstack/react-router";
import { AlertCircle, PanelsTopLeft } from "lucide-react";
import {
  channelAgentIdentity,
  channelLead,
  type ChannelConversationMessage,
} from "@channels/model";
import { useChannel } from "@channels/useChannel";
import type { WorkspaceFile } from "@files/model";
import type { PaneVariant } from "@workspace/components/panes/shell/WorkspacePaneView";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { useEditSavedDraft } from "@workspace/hooks/useSavedDraft";
import {
  CHANNEL_ASIDE_MAX_SIZE,
  CHANNEL_ASIDE_MIN_SIZE,
} from "@workspace/model/config/layoutPrefs";
import { createEditorPaneId } from "@workspace/model/panes";
import { TranscriptSkeleton } from "@/shared/messages/TranscriptSkeleton";
import { PaneActions } from "@workspace/components/panes/shell/PaneSlots";
import {
  PANE_OVERLAY_BUTTON_CLASS,
  PANE_OVERLAY_ICON_CLASS,
} from "@workspace/components/panes/shell/paneControls";
import { Button } from "@/shared/ui/button";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { cn } from "@/shared/utils";
import { ChannelCanvas } from "./ChannelCanvas";
import { ChannelArtifacts } from "./ChannelArtifacts";
import {
  addressedDraft,
  ChannelComposer,
  channelDraftKey,
  type ChannelComposerHandle,
} from "./ChannelComposer";
import { ChannelPaneProvider } from "./ChannelPaneContext";
import { ChannelThread } from "./ChannelThread";
import { ChannelOverview } from "./overview/ChannelOverview";
import { ChannelTranscript, type ChannelTranscriptHandle } from "./transcript/ChannelTranscript";
import type { TranscriptView } from "./transcript/transcriptRows";
import { TranscriptViewMenu } from "./transcript/TranscriptViewMenu";

/** What this view shows beside the chat, or in its place when the pane is narrow. */
type ChannelAside =
  | { type: "canvas" }
  | { type: "thread"; sequence: number }
  | { type: "artifacts" };

/** Each aside kind's share of a wide pane until the user resizes it. */
const ASIDE_SIZES: Record<ChannelAside["type"], number> = { canvas: 50, thread: 35, artifacts: 35 };

export function ChannelPane({
  channelId,
  isVisible,
  variant,
}: {
  channelId: string;
  isVisible: boolean;
  variant: PaneVariant;
}) {
  return (
    <CatchBoundary getResetKey={() => channelId} errorComponent={ChannelPaneError}>
      <ChannelContent
        key={channelId}
        channelId={channelId}
        isVisible={isVisible}
        variant={variant}
      />
    </CatchBoundary>
  );
}

function ChannelContent({
  channelId,
  isVisible,
  variant,
}: {
  channelId: string;
  isVisible: boolean;
  variant: PaneVariant;
}) {
  const { state, unreadAfter, loadPrevious, postMessage, postError } = useChannel(channelId, {
    visible: isVisible,
  });
  const transcriptRef = useRef<ChannelTranscriptHandle>(null);
  const composerRef = useRef<ChannelComposerHandle>(null);
  const threadComposerRef = useRef<ChannelComposerHandle>(null);
  const editSavedDraft = useEditSavedDraft();
  const { revealFile, focusedPaneAtom, channelAsideSizes, setChannelAsideSize } =
    useWorkspaceSurface();
  const [view, setView] = useState<TranscriptView>("all");
  const [aside, setAside] = useState<ChannelAside | null>(null);
  const canvas = state?.artifacts.find(({ id }) => id === state.channel.canvasArtifactId);
  const showingCanvas = aside?.type === "canvas" && !!canvas;
  const thread = aside?.type === "thread" && state ? aside.sequence : undefined;
  const showingArtifacts = aside?.type === "artifacts" && !!state;
  const asideKind =
    showingCanvas || thread !== undefined || showingArtifacts ? aside?.type : undefined;
  const asideSize = asideKind && (channelAsideSizes?.[asideKind] ?? ASIDE_SIZES[asideKind]);
  // A drag commits only the size it ends at, so following the pointer stays within the panels.
  const resizeRef = useRef<{ size?: number; dragging: boolean }>({ dragging: false });
  const canvasLabel = showingCanvas ? "Close channel canvas" : "Open channel canvas";
  // The lead is intrinsic, so the composer can address it before the first snapshot arrives.
  const lead = state?.lead ?? channelLead(channelId);
  const members = state?.members ?? [];
  const agents = [lead, ...members];
  const toggleCanvas = () => setAside(showingCanvas ? null : { type: "canvas" });

  function openThread(sequence: number) {
    if (thread === sequence) threadComposerRef.current?.focus();
    else setAside({ type: "thread", sequence });
  }

  function openArtifact(file: WorkspaceFile) {
    if (revealFile) revealFile(file);
    else focusedPaneAtom.set(createEditorPaneId(file));
  }

  function rememberAsideSize(size: number | undefined) {
    if (!asideKind || size === undefined) return;
    const rounded = Math.round(size * 10) / 10;
    if (rounded !== asideSize) setChannelAsideSize?.(asideKind, rounded);
  }

  /** Opens the message's thread with the draft addressed to its agent, as a reply wakes them. */
  function replyInThread(message: ChannelConversationMessage) {
    const sequence = message.threadSequence ?? message.sequence;
    const author =
      message.sender.type === "agent"
        ? channelAgentIdentity(agents, message.sender.agentId)
        : undefined;
    const addressee = author && !author.deleted ? author : undefined;
    if (thread === sequence) {
      if (addressee) threadComposerRef.current?.reply(addressee);
      else threadComposerRef.current?.focus();
      return;
    }
    if (addressee) {
      editSavedDraft(channelDraftKey(channelId, sequence), (text) =>
        addressedDraft(text, addressee),
      );
    }
    setAside({ type: "thread", sequence });
  }

  return (
    <ChannelPaneProvider
      value={{
        lead,
        members,
        agents,
        agent: (id) => channelAgentIdentity(agents, id),
        presence: state?.presence ?? {},
        openThread,
        replyInThread,
        isSending: (id) => state?.optimisticMessageIds?.includes(id) ?? false,
        mention: () => composerRef.current?.mention(),
        openArtifact,
        openArtifacts: () => setAside({ type: "artifacts" }),
      }}
    >
      {canvas && (
        <PaneActions>
          {variant === "normal" ? (
            <button
              type="button"
              aria-label={canvasLabel}
              title={canvasLabel}
              aria-pressed={showingCanvas}
              className={PANE_OVERLAY_BUTTON_CLASS}
              onClick={toggleCanvas}
            >
              <PanelsTopLeft className={PANE_OVERLAY_ICON_CLASS} />
            </button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={canvasLabel}
              title={canvasLabel}
              aria-pressed={showingCanvas}
              onClick={toggleCanvas}
            >
              <PanelsTopLeft />
            </Button>
          )}
        </PaneActions>
      )}
      <div className="@container/channel h-full min-h-0">
        {/* A narrow pane shows the aside in place of chat, so only a wide one divides them. */}
        <ResizablePanelGroup direction="horizontal" className="bg-background">
          <ResizablePanel
            id="chat"
            order={1}
            defaultSize={100 - (asideSize ?? 0)}
            minSize={100 - CHANNEL_ASIDE_MAX_SIZE}
            className={cn(asideKind && "hidden @3xl/channel:block")}
          >
            <div className="grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto]">
              {state && (
                <ChannelOverview
                  channel={state.channel}
                  artifacts={state.artifacts}
                  routines={state.routines}
                  variant={variant}
                  allowPin={!asideKind}
                  actions={
                    <TranscriptViewMenu view={view} onViewChange={setView} variant={variant} />
                  }
                />
              )}
              <div className="col-start-1 row-start-1 min-h-0">
                {state ? (
                  <ChannelTranscript
                    // Each view lands afresh, since its rows and their keys differ.
                    key={view}
                    messages={state.messages}
                    view={view}
                    unreadAfter={unreadAfter}
                    handleRef={transcriptRef}
                    requestSequence={state.channel.requestSequence}
                    onLoadPrevious={loadPrevious}
                  />
                ) : (
                  <TranscriptSkeleton />
                )}
              </div>
              <div className="col-start-1 row-start-2 shrink-0 border-t bg-background px-4 pt-4 md:pb-4">
                {postError && (
                  <p role="alert" className="mb-2 text-sm text-destructive">
                    Unable to send message: {postError.message}
                  </p>
                )}
                <ChannelComposer
                  channelId={channelId}
                  state={state}
                  handleRef={composerRef}
                  onSubmit={(message) => {
                    transcriptRef.current?.followNextPost();
                    return postMessage(message);
                  }}
                  onShowRequest={() => {
                    // A question asked in a thread is answered there.
                    const requestThread = state?.request?.threadSequence;
                    if (requestThread === undefined) transcriptRef.current?.showRequest();
                    else openThread(requestThread);
                  }}
                />
              </div>
            </div>
          </ResizablePanel>
          {asideKind && (
            <>
              <ResizableHandle
                aria-label="Resize channel aside"
                className="hidden @3xl/channel:flex"
                onDragging={(dragging) => {
                  resizeRef.current.dragging = dragging;
                  if (!dragging) rememberAsideSize(resizeRef.current.size);
                }}
              />
              {/* Each kind is its own panel, so switching kinds restores that kind's size. */}
              <ResizablePanel
                id={asideKind}
                order={2}
                defaultSize={asideSize}
                minSize={CHANNEL_ASIDE_MIN_SIZE}
                maxSize={CHANNEL_ASIDE_MAX_SIZE}
                onResize={(size) => {
                  resizeRef.current.size = size;
                  if (!resizeRef.current.dragging) rememberAsideSize(size);
                }}
              >
                {showingCanvas && (
                  <ChannelCanvas
                    key={canvas.id}
                    channelId={channelId}
                    artifact={canvas}
                    onClose={() => setAside(null)}
                  />
                )}
                {thread !== undefined && state && (
                  <ChannelThread
                    key={thread}
                    channelId={channelId}
                    sequence={thread}
                    state={state}
                    composerRef={threadComposerRef}
                    onLoadThrough={loadPrevious}
                    onReply={(message) => postMessage({ ...message, threadSequence: thread })}
                    onClose={() => setAside(null)}
                  />
                )}
                {showingArtifacts && (
                  <ChannelArtifacts
                    channelId={channelId}
                    artifacts={state.artifacts}
                    onClose={() => setAside(null)}
                  />
                )}
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </ChannelPaneProvider>
  );
}

function ChannelPaneError({ error }: { error: unknown }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertCircle className="size-6 text-destructive" />
      <p className="font-medium">Channel unavailable</p>
      <p className="text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "It may have been deleted."}
      </p>
    </div>
  );
}
