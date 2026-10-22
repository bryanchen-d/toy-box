import { lazy, Suspense } from "react";
import { PanelRightClose, PanelsTopLeft } from "lucide-react";
import type { ChannelArtifact } from "@channels/model";
import { useFile } from "@files/useFile";
import { Button } from "@/shared/ui/button";
import { PaneMessage } from "@/shared/ui/pane-message";

const ArtifactAppPane = lazy(() =>
  import("@apps/components/panes/ArtifactAppPane").then((module) => ({
    default: module.ArtifactAppPane,
  })),
);

/** A channel's selected app, using the ordinary artifact compilation and file lifecycle. */
export function ChannelCanvas({
  channelId,
  artifact,
  onClose,
}: {
  channelId: string;
  artifact: ChannelArtifact;
  onClose: () => void;
}) {
  const file = useFile(artifact.file, "read");
  const loading = <PaneMessage title="Loading canvas" detail="Loading the shared app..." loading />;

  return (
    <section
      aria-label="Channel canvas"
      className="flex min-h-0 min-w-0 flex-col @3xl/channel:border-l"
    >
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b px-3 pr-24">
        <PanelsTopLeft className="size-4 shrink-0 text-muted-foreground" />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{artifact.title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Return to channel chat"
          title="Close canvas"
          onClick={onClose}
        >
          <PanelRightClose />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {file.error ? (
          <PaneMessage title="Canvas unavailable" detail={file.error} />
        ) : file.isReady ? (
          <Suspense fallback={loading}>
            <ArtifactAppPane
              title={artifact.title}
              file={file}
              publisherPaneId={`channel-canvas:${channelId}`}
            />
          </Suspense>
        ) : (
          loading
        )}
      </div>
    </section>
  );
}
