import { useRef, useState } from "react";
import { CatchBoundary } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { channelAgentIdentity, channelLead } from "@channels/model";
import { useChannel } from "@channels/useChannel";
import type { PaneVariant } from "@workspace/components/panes/shell/WorkspacePaneView";
import { TranscriptSkeleton } from "@/shared/messages/TranscriptSkeleton";
import { ChannelComposer, type ChannelComposerHandle } from "./ChannelComposer";
import { ChannelPaneProvider } from "./ChannelPaneContext";
import { ChannelOverview } from "./overview/ChannelOverview";
import { ChannelTranscript, type ChannelTranscriptHandle } from "./transcript/ChannelTranscript";
import type { TranscriptView } from "./transcript/transcriptRows";
import { TranscriptViewMenu } from "./transcript/TranscriptViewMenu";

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
  const { state, unreadAfter, loadPrevious, postMessage } = useChannel(channelId, {
    visible: isVisible,
  });
  const transcriptRef = useRef<ChannelTranscriptHandle>(null);
  const composerRef = useRef<ChannelComposerHandle>(null);
  const [view, setView] = useState<TranscriptView>("all");
  // The lead is intrinsic, so the composer can address it before the first snapshot arrives.
  const lead = state?.lead ?? channelLead(channelId);
  const members = state?.members ?? [];
  const agents = [lead, ...members];
  return (
    <ChannelPaneProvider
      value={{
        lead,
        members,
        agents,
        agent: (id) => channelAgentIdentity(agents, id),
        presence: state?.presence ?? {},
        reply: (agent) => composerRef.current?.reply(agent),
        mention: () => composerRef.current?.mention(),
      }}
    >
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)_auto] grid-rows-[minmax(0,1fr)_auto] bg-background">
        {state && (
          <ChannelOverview
            channel={state.channel}
            artifacts={state.artifacts}
            routines={state.routines}
            variant={variant}
            actions={<TranscriptViewMenu view={view} onViewChange={setView} variant={variant} />}
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
          <ChannelComposer
            channelId={channelId}
            state={state}
            handleRef={composerRef}
            onSubmit={(message) => {
              transcriptRef.current?.followNextPost();
              postMessage(message);
            }}
            onShowRequest={() => transcriptRef.current?.showRequest()}
          />
        </div>
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
