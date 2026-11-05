import { lazy, Suspense } from "react";
import { PanelsTopLeft } from "lucide-react";
import type { TeamArtifact } from "@teams/model";
import { useFile } from "@files/useFile";
import { PaneMessage } from "@/shared/ui/pane-message";
import { TeamPanelHeader } from "./TeamPanelHeader";

const ArtifactAppPane = lazy(() =>
  import("@apps/components/panes/ArtifactAppPane").then((module) => ({
    default: module.ArtifactAppPane,
  })),
);

/** A team's selected app, using the ordinary artifact compilation and file lifecycle. */
export function TeamCanvas({ teamId, artifact }: { teamId: string; artifact: TeamArtifact }) {
  const file = useFile(artifact.file, "read");
  const loading = <PaneMessage title="Loading canvas" detail="Loading the shared app..." loading />;

  return (
    <section aria-label="Team canvas" className="flex h-full min-h-0 min-w-0 flex-col">
      <TeamPanelHeader icon={PanelsTopLeft} title={artifact.title} />
      <div className="min-h-0 flex-1">
        {file.error ? (
          <PaneMessage title="Canvas unavailable" detail={file.error} />
        ) : file.isReady ? (
          <Suspense fallback={loading}>
            <ArtifactAppPane
              title={artifact.title}
              file={file}
              publisherPaneId={`team-canvas:${teamId}`}
            />
          </Suspense>
        ) : (
          loading
        )}
      </div>
    </section>
  );
}
