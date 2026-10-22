import { ClientOnly } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { EditorProps } from "@files/components/editor/kinds";
import type { SessionFile } from "@files/model";
import { appQueries } from "@apps/queries";
import { createEditorPaneId } from "@workspace/model/panes";
import { PaneMessage } from "@/shared/ui/pane-message";
import { AppErrorBoundary, AppHost, appErrorMessage } from "../host/AppHost";

/** Renders a stateless session `.toy` file through the shared app host. */
export function ArtifactAppPane({
  title,
  file,
  publisherPaneId,
}: Pick<EditorProps, "title" | "file"> & { publisherPaneId?: string }) {
  const { source } = file;
  if (source.kind !== "session") {
    return (
      <PaneMessage
        title="Artifact app unavailable"
        detail="Only files owned by a session can run as artifact apps."
      />
    );
  }

  return (
    <ClientOnly
      fallback={<PaneMessage title={`Loading ${title}`} detail="Compiling app…" loading />}
    >
      <MountedApp
        source={source}
        title={title}
        revision={file.revision}
        publisherPaneId={publisherPaneId ?? createEditorPaneId(source)}
      />
    </ClientOnly>
  );
}

function MountedApp({
  source,
  title,
  revision,
  publisherPaneId,
}: {
  source: SessionFile;
  title: string;
  revision: number;
  publisherPaneId: string;
}) {
  const bundleQuery = useQuery(appQueries.artifactBundle(source, revision));

  if (bundleQuery.isPending) {
    return <PaneMessage title={`Loading ${title}`} detail="Compiling app…" loading />;
  }
  if (bundleQuery.isError) {
    return (
      <PaneMessage title={`Unable to load ${title}`} detail={appErrorMessage(bundleQuery.error)} />
    );
  }

  const { Component: AppComponent, css, scopeId } = bundleQuery.data;
  return (
    <AppErrorBoundary title={title} resetKey={revision}>
      <AppHost
        scopeId={scopeId}
        publisherPaneId={publisherPaneId}
        AppComponent={AppComponent}
        css={css}
      />
    </AppErrorBoundary>
  );
}
