import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { selectAutomationSessionIds, sessionQueries } from "@sessions/queries";
import { useEffect, useRef, type ReactNode } from "react";
import { createAtom, createStoreContext } from "@tanstack/react-store";
import { useWorkspaceSelector } from "@workspace/hooks/state";
import { createPanePublicationsStore } from "@workspace/hooks/layout/panePublications";
import {
  createEditorPaneId,
  createScreenPane,
  MAX_HYPER_PANES,
  MAX_WORKSPACE_PANES,
  resolveEditorAutoFocus,
  type WorkspacePane,
} from "@workspace/model/panes";
import { sessionFile, type WorkspaceFile } from "@files/model";

// Store identities follow the browser workspace, not a host mount; Hyper may
// unmount while minimized.
function createWorkspaceSurface(capacity: number) {
  return {
    capacity,
    focusedPaneAtom: createAtom<string | null>(null),
    panePublications: createPanePublicationsStore(),
  };
}

export const workspaceSurfaces = {
  main: createWorkspaceSurface(MAX_WORKSPACE_PANES),
  hyper: createWorkspaceSurface(MAX_HYPER_PANES),
};

export type WorkspaceSurface = keyof typeof workspaceSurfaces;

const { StoreProvider, useStoreContext: useWorkspaceSurface } = createStoreContext<
  (typeof workspaceSurfaces)[WorkspaceSurface] & {
    panes: readonly WorkspacePane[];
    openApp: (appId: string) => void;
    openFile?: (path: string) => void;
    /** Brings a file's pane forward, opening the file when it isn't showing. */
    revealFile?: (file: WorkspaceFile) => void;
    revealScreen: (screenId: string) => boolean;
    /** Whether Channel overviews stay pinned open, where the surface remembers it. */
    channelOverviewPinned?: boolean;
    setChannelOverviewPinned?: (pinned: boolean) => void;
  }
>();
export { useWorkspaceSurface };

/** Focus a pane from its host, outside the surface subtree. */
export function focusWorkspaceSurfacePane(surface: WorkspaceSurface, paneId: string): void {
  workspaceSurfaces[surface].focusedPaneAtom.set(paneId);
}

export function useFocusedPaneAtom() {
  return useWorkspaceSurface().focusedPaneAtom;
}

export function WorkspaceSurfaceProvider({
  surface,
  panes,
  onOpenApp,
  onOpenFile,
  onRevealFile,
  onOpenScreen,
  channelOverviewPinned,
  onChannelOverviewPinnedChange,
  children,
}: {
  surface: WorkspaceSurface;
  panes: WorkspacePane[];
  onOpenApp: (appId: string) => void;
  onOpenFile?: (path: string) => void;
  onRevealFile?: (file: WorkspaceFile) => void;
  onOpenScreen?: (screenId: string) => Promise<void>;
  channelOverviewPinned?: boolean;
  onChannelOverviewPinnedChange?: (pinned: boolean) => void;
  children: ReactNode;
}) {
  const workspaceSurface = workspaceSurfaces[surface];
  const autoFocusArtifacts = useWorkspaceSelector(
    (workspace) => workspace.settings.autoFocusArtifacts,
  );
  const { data: automationSessionIds } = useSuspenseQuery({
    ...sessionQueries.state(),
    select: selectAutomationSessionIds,
  });
  const { data: initialEditorPaneIds = [] } = useQuery({
    ...sessionQueries.state(),
    select: (state) =>
      state.sessions.flatMap((session) =>
        !session.provider && session.artifactPath
          ? [createEditorPaneId(sessionFile(session.id, session.artifactPath))]
          : [],
      ),
  });
  const seenPaneIdsRef = useRef<ReadonlySet<string> | null>(null);

  function revealScreen(screenId: string): boolean {
    const paneId = createScreenPane(screenId).id;
    const published = Object.values(workspaceSurface.panePublications.get()).some((linked) =>
      linked.some((pane) => pane.id === paneId),
    );
    if (published || panes.some((pane) => pane.id === paneId)) {
      workspaceSurface.focusedPaneAtom.set(paneId);
      return true;
    }
    if (!onOpenScreen) return false;
    void onOpenScreen(screenId)
      .then(() => workspaceSurface.focusedPaneAtom.set(paneId))
      .catch((error) => console.error("Unable to open screen:", error));
    return true;
  }

  // Panes present when a surface mounts are not newly opened, except for an
  // artifact-first draft whose artifact is the surface's initial destination.
  if (seenPaneIdsRef.current === null) {
    const initialEditorPaneIdSet = new Set(initialEditorPaneIds);
    seenPaneIdsRef.current = new Set(
      panes.filter((pane) => !initialEditorPaneIdSet.has(pane.id)).map((pane) => pane.id),
    );
  }

  // Keep this surface's focus valid and let newly opened artifacts claim it.
  useEffect(() => {
    const initialEditorPaneIdSet = new Set(initialEditorPaneIds);
    const { focusPane, seenPaneIds } = resolveEditorAutoFocus(
      seenPaneIdsRef.current!,
      panes,
      autoFocusArtifacts,
      automationSessionIds,
      initialEditorPaneIdSet,
    );
    seenPaneIdsRef.current = seenPaneIds;

    workspaceSurface.focusedPaneAtom.set((current) => {
      const currentIsVisible = current !== null && panes.some((pane) => pane.id === current);
      if (currentIsVisible) return current;
      return focusPane?.id ?? null;
    });
  }, [
    autoFocusArtifacts,
    automationSessionIds,
    initialEditorPaneIds,
    panes,
    workspaceSurface.focusedPaneAtom,
  ]);

  return (
    <StoreProvider
      value={{
        ...workspaceSurface,
        panes,
        openApp: onOpenApp,
        openFile: onOpenFile,
        revealFile: onRevealFile,
        revealScreen,
        channelOverviewPinned,
        setChannelOverviewPinned: onChannelOverviewPinnedChange,
      }}
    >
      {children}
    </StoreProvider>
  );
}
