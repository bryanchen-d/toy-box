import { useRef, useState } from "react";
import { CatchBoundary, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { teamQueries } from "@teams/queries";
import { parseTeamReferenceHash } from "@teams/model/references";
import { AlertCircle } from "lucide-react";
import {
  connectorAuthor,
  messageAuthorId,
  teamAgentIdentity,
  teamAuthor,
  teamLead,
  type TeamConversationMessage,
} from "@teams/model";
import { connectorQueries } from "@connectors/queries";
import { securityQueries } from "@security/queries";
import { useTeam } from "@teams/useTeam";
import type { WorkspaceFile } from "@files/model";
import type { PaneVariant } from "@workspace/components/panes/shell/WorkspacePaneView";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { useEditSavedDraft } from "@workspace/hooks/useSavedDraft";
import { TEAM_ASIDE_MAX_SIZE, TEAM_ASIDE_MIN_SIZE } from "@workspace/model/config/layoutPrefs";
import { createEditorPaneId } from "@workspace/model/panes";
import { TranscriptSkeleton } from "@/shared/messages/TranscriptSkeleton";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/shared/ui/resizable";
import { cn } from "@/shared/utils";
import { TeamCanvas } from "./TeamCanvas";
import { TeamArtifacts } from "./TeamArtifacts";
import { TeamMembers } from "./TeamMembers";
import { TeamPerformance } from "./TeamPerformance";
import {
  addressedDraft,
  TeamComposer,
  teamDraftKey,
  type TeamComposerHandle,
} from "./TeamComposer";
import { TeamPaneProvider } from "./TeamPaneContext";
import { TeamPanelBar } from "./TeamPanelBar";
import { TeamRoutines } from "./TeamRoutines";
import { TeamSecurity } from "./TeamSecurity";
import { TeamTasks } from "./TeamTasks";
import { TeamThread } from "./TeamThread";
import { TeamMessageSearch } from "./TeamMessageSearch";
import { TeamOverview } from "./overview/TeamOverview";
import { isTeamPanel, type TeamPanel } from "./panels";
import { TeamTranscript, type TeamTranscriptHandle } from "./transcript/TeamTranscript";
import type { TranscriptView } from "./transcript/transcriptRows";
import { TranscriptViewMenu } from "./transcript/TranscriptViewMenu";

/** What this view shows beside the chat, or in its place when the pane is narrow. */
type TeamAside =
  | { type: TeamPanel; selectedAgentId?: string }
  | { type: "thread"; sequence: number; selectedSequence?: number };

/** Each aside kind's share of a wide pane until the user resizes it. */
const ASIDE_SIZES: Record<TeamAside["type"], number> = {
  overview: 30,
  canvas: 50,
  members: 65,
  tasks: 35,
  artifacts: 35,
  routines: 30,
  performance: 50,
  security: 35,
  thread: 35,
};

export function TeamPane({
  teamId,
  isVisible,
  variant,
}: {
  teamId: string;
  isVisible: boolean;
  variant: PaneVariant;
}) {
  return (
    <CatchBoundary getResetKey={() => teamId} errorComponent={TeamPaneError}>
      <TeamContent key={teamId} teamId={teamId} isVisible={isVisible} variant={variant} />
    </CatchBoundary>
  );
}

function TeamContent({
  teamId,
  isVisible,
  variant,
}: {
  teamId: string;
  isVisible: boolean;
  variant: PaneVariant;
}) {
  const { state, unreadAfter, loadPrevious, postMessage, postError } = useTeam(teamId, {
    visible: isVisible,
  });
  const transcriptRef = useRef<TeamTranscriptHandle>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<TeamComposerHandle>(null);
  const threadComposerRef = useRef<TeamComposerHandle>(null);
  const editSavedDraft = useEditSavedDraft();
  const { revealFile, focusedPaneAtom, teamAsideSizes, setTeamAsideSize, teamPanel, setTeamPanel } =
    useWorkspaceSurface();
  const [view, setView] = useState<TranscriptView>("all");
  // A normal pane opens the surface's remembered panel; a compact one keeps its own, so a
  // narrow pane still opens on chat.
  const remembersPanel = variant === "normal" && setTeamPanel !== undefined;
  const [ownPanel, setOwnPanel] = useState<TeamPanel>();
  const panel = remembersPanel ? (isTeamPanel(teamPanel) ? teamPanel : undefined) : ownPanel;
  const [lastPanel, setLastPanel] = useState<TeamPanel>(panel ?? "overview");
  if (panel && panel !== lastPanel) setLastPanel(panel);
  // A thread or reference opens over the panel until it closes.
  const [opened, setOpened] = useState<TeamAside>();
  const location = useRouterState({ select: ({ location }) => location });
  const hash = location.hash;
  const target = parseTeamReferenceHash(hash);
  const reference = target?.teamId === teamId ? target : undefined;
  const selectedSequence = reference?.type === "message" ? reference.sequence : undefined;
  const referenceThread = useQuery({
    ...teamQueries.threadSequence(teamId, selectedSequence ?? 0),
    enabled: isVisible && selectedSequence !== undefined,
  });
  const [openedLocation, setOpenedLocation] = useState<typeof location>();
  if (
    state &&
    reference &&
    location !== openedLocation &&
    (reference.type !== "message" || referenceThread.data !== undefined)
  ) {
    setOpenedLocation(location);
    if (reference.type === "members" || reference.type === "agent")
      setOpened({
        type: "members",
        selectedAgentId: reference.type === "agent" ? reference.agentId : undefined,
      });
    else if (reference.type === "message")
      setOpened({
        type: "thread",
        sequence: referenceThread.data!,
        selectedSequence: reference.sequence,
      });
    else setOpened(undefined);
  }
  const canvas = state?.artifacts.find(({ id }) => id === state.team.canvasArtifactId);
  const aside = opened ?? (panel && { type: panel });
  const asideKind = state && aside && (aside.type !== "canvas" || canvas) ? aside.type : undefined;
  const thread = aside?.type === "thread" && asideKind ? aside.sequence : undefined;
  const asideSize = asideKind && (teamAsideSizes?.[asideKind] ?? ASIDE_SIZES[asideKind]);
  // A drag commits only the size it ends at, so following the pointer stays within the panels.
  const resizeRef = useRef<{ size?: number; dragging: boolean }>({ dragging: false });
  // The lead is intrinsic, so the composer can address it before the first snapshot arrives.
  const lead = state?.lead ?? teamLead(teamId);
  const members = state?.members ?? [];
  const agents = [lead, ...members];
  const { data: connectors = [] } = useQuery(connectorQueries.list());
  const { data: catalog } = useQuery(teamQueries.list());
  // Connectors, other teams, and members who moved to another team wrote messages here too, so
  // one lookup names every author.
  const authors = [
    ...agents,
    ...connectors.map(connectorAuthor),
    ...(catalog?.teams ?? []).filter(({ id }) => id !== teamId).map(teamAuthor),
    ...(catalog?.members ?? []).filter((member) => member.teamId !== teamId),
  ];
  const agentIds = new Set(agents.map(({ id }) => id));
  const { data: securityAlert = false } = useQuery({
    ...securityQueries.open(),
    select: (open) => open.some(({ sessionId }) => agentIds.has(sessionId)),
  });

  function setPanel(next: TeamPanel | undefined) {
    if (remembersPanel) setTeamPanel?.(next);
    else setOwnPanel(next);
  }

  function openPanel(next: TeamPanel) {
    setOpened(undefined);
    setPanel(next);
  }

  function togglePanel(next: TeamPanel) {
    setOpened(undefined);
    setPanel(asideKind === next ? undefined : next);
  }

  /** Closing what opened over the panel returns to it; closing the panel returns to chat. */
  function closeAside() {
    if (opened) setOpened(undefined);
    else setPanel(undefined);
  }

  function openThread(sequence: number) {
    if (thread === sequence) threadComposerRef.current?.focus();
    else setOpened({ type: "thread", sequence });
  }

  function openArtifact(file: WorkspaceFile) {
    if (revealFile) revealFile(file);
    else focusedPaneAtom.set(createEditorPaneId(file));
  }

  function rememberAsideSize(size: number | undefined) {
    if (!asideKind || size === undefined) return;
    const rounded = Math.round(size * 10) / 10;
    if (rounded !== asideSize) setTeamAsideSize?.(asideKind, rounded);
  }

  /** Opens the message's thread with the draft addressed to its author, as a reply wakes them. */
  function replyInThread(message: TeamConversationMessage) {
    const sequence = message.threadSequence ?? message.sequence;
    const authorId = messageAuthorId(message.sender);
    const author = authorId ? teamAgentIdentity(authors, authorId) : undefined;
    const addressee = author && !author.deleted ? author : undefined;
    if (thread === sequence) {
      if (addressee) threadComposerRef.current?.reply(addressee);
      else threadComposerRef.current?.focus();
      return;
    }
    if (addressee) {
      editSavedDraft(teamDraftKey(teamId, sequence), (text) => addressedDraft(text, addressee));
    }
    setOpened({ type: "thread", sequence });
  }

  return (
    <TeamPaneProvider
      value={{
        teamId,
        selectedMessageSequence: aside?.type === "thread" ? aside.selectedSequence : undefined,
        lead,
        members,
        agents,
        agent: (id) => teamAgentIdentity(authors, id),
        presence: state?.presence ?? {},
        openThread,
        replyInThread,
        isSending: (id) => state?.optimisticMessageIds?.includes(id) ?? false,
        mention: () => composerRef.current?.mention(),
        openArtifact,
        openPanel,
      }}
    >
      <div className="flex h-full min-h-0">
        <div className="@container/team h-full min-h-0 min-w-0 flex-1">
          {referenceThread.error && selectedSequence !== undefined && (
            <p role="alert" className="p-3 text-sm text-destructive">
              Message unavailable: {referenceThread.error.message}
            </p>
          )}
          {!target && /^team(?::|%3a)/i.test(hash) && (
            <p role="alert" className="p-3 text-sm text-destructive">
              Invalid team reference.
            </p>
          )}
          {/* A narrow pane shows the aside in place of chat, so only a wide one divides them. */}
          <ResizablePanelGroup direction="horizontal" className="bg-background">
            <ResizablePanel
              id="chat"
              order={1}
              defaultSize={100 - (asideSize ?? 0)}
              minSize={100 - TEAM_ASIDE_MAX_SIZE}
              className={cn(asideKind && "hidden @3xl/team:block")}
            >
              <div
                ref={chatRef}
                tabIndex={-1}
                className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] outline-none"
              >
                <div className="row-start-1 flex min-h-0 flex-col">
                  {state && (
                    <TeamMessageSearch
                      teamId={teamId}
                      isVisible={isVisible}
                      hotkeyTarget={chatRef}
                      onSelect={(match) =>
                        setOpened({
                          type: "thread",
                          sequence: match.threadSequence,
                          selectedSequence: match.sequence,
                        })
                      }
                      actions={<TranscriptViewMenu view={view} onViewChange={setView} />}
                      // Chat meets the panel bar while no aside is open, so the row keeps its end
                      // clear of the pane's floating actions beyond the bar's 2.5rem.
                      className={cn(
                        !asideKind &&
                          "pr-[max(0.75rem,calc(var(--agent-teams-pane-actions-inset,0px)-2.5rem))]",
                      )}
                    />
                  )}
                  <div className="min-h-0 flex-1">
                    {state ? (
                      <TeamTranscript
                        // Each view lands afresh, since its rows and their keys differ.
                        key={view}
                        messages={state.messages}
                        view={view}
                        unreadAfter={unreadAfter}
                        handleRef={transcriptRef}
                        requestSequence={state.team.requestSequence}
                        onLoadPrevious={loadPrevious}
                      />
                    ) : (
                      <TranscriptSkeleton />
                    )}
                  </div>
                </div>
                <div className="col-start-1 row-start-2 shrink-0 border-t bg-background px-4 pt-4 md:pb-4">
                  {postError && (
                    <p role="alert" className="mb-2 text-sm text-destructive">
                      Unable to send message: {postError.message}
                    </p>
                  )}
                  <TeamComposer
                    teamId={teamId}
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
            {asideKind && state && aside && (
              <>
                <ResizableHandle
                  aria-label="Resize team aside"
                  className="hidden @3xl/team:flex"
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
                  minSize={TEAM_ASIDE_MIN_SIZE}
                  maxSize={TEAM_ASIDE_MAX_SIZE}
                  onResize={(size) => {
                    resizeRef.current.size = size;
                    if (!resizeRef.current.dragging) rememberAsideSize(size);
                  }}
                >
                  {aside.type === "overview" && (
                    <TeamOverview
                      team={state.team}
                      artifacts={state.artifacts}
                      routines={state.routines}
                    />
                  )}
                  {aside.type === "canvas" && canvas && (
                    <TeamCanvas key={canvas.id} teamId={teamId} artifact={canvas} />
                  )}
                  {aside.type === "thread" && (
                    <TeamThread
                      key={`${aside.sequence}:${aside.selectedSequence ?? ""}`}
                      teamId={teamId}
                      sequence={aside.sequence}
                      selectedSequence={aside.selectedSequence}
                      isVisible={isVisible}
                      state={state}
                      composerRef={threadComposerRef}
                      onLoadThrough={loadPrevious}
                      onReply={(message) =>
                        postMessage({ ...message, threadSequence: aside.sequence })
                      }
                    />
                  )}
                  {aside.type === "members" && (
                    <TeamMembers
                      team={state.team}
                      isVisible={isVisible}
                      selectedAgentId={aside.selectedAgentId}
                    />
                  )}
                  {aside.type === "tasks" && (
                    <TeamTasks team={state.team} artifacts={state.artifacts} />
                  )}
                  {aside.type === "artifacts" && (
                    <TeamArtifacts teamId={teamId} artifacts={state.artifacts} />
                  )}
                  {aside.type === "routines" && (
                    <TeamRoutines team={state.team} routines={state.routines} agents={agents} />
                  )}
                  {aside.type === "performance" && (
                    <TeamPerformance
                      team={state.team}
                      advice={state.advice}
                      isVisible={isVisible}
                      onAskLead={(content) => postMessage({ content })}
                    />
                  )}
                  {aside.type === "security" && <TeamSecurity agents={agents} />}
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
        <TeamPanelBar
          panel={isTeamPanel(asideKind) ? asideKind : undefined}
          asideOpen={asideKind !== undefined}
          hasCanvas={!!canvas}
          alerts={new Set<TeamPanel>(securityAlert ? ["security"] : [])}
          variant={variant}
          onToggle={togglePanel}
          onToggleAside={() => {
            if (asideKind) closeAside();
            else openPanel(lastPanel === "canvas" && !canvas ? "overview" : lastPanel);
          }}
        />
      </div>
    </TeamPaneProvider>
  );
}

function TeamPaneError({ error }: { error: unknown }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <AlertCircle className="size-6 text-destructive" />
      <p className="font-medium">Team unavailable</p>
      <p className="text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "It may have been deleted."}
      </p>
    </div>
  );
}
