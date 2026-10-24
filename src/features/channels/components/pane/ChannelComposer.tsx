import { AgentMentionMarkdown } from "@channels/components/agents/AgentMentionMarkdown";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/shared/ui/preview-card";
import { RunningIndicator } from "@/shared/ui/running-indicator";
import { useImperativeHandle, type RefObject } from "react";
import { useMutation } from "@tanstack/react-query";
import { AgentAvatar } from "@channels/components/agents/AgentAvatar";
import { AgentCompletionMenu } from "@channels/components/agents/AgentCompletionMenu";
import { agentCompletionSource } from "@channels/components/agents/agentCompletionSource";
import {
  agentHandleFromName,
  channelAudienceLabel,
  channelHasPendingRequest,
  channelTasksDiff,
  resolveChannelAudience,
  type ChannelAgent,
  type ChannelState,
  type PostChannelMessageInput,
} from "@channels/model";
import { channelMutations } from "@channels/mutations";
import type { WorkspaceFile } from "@files/model";
import { ComposerTray } from "@workspace/components/outputs/ComposerTray";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { useSavedDraft } from "@workspace/hooks/useSavedDraft";
import type { DraftKey } from "@workspace/model/state/drafts";
import { createEditorPaneId } from "@workspace/model/panes";
import { Composer, ComposerSendButton } from "@/shared/composers/Composer";
import { useComposerDraft } from "@/shared/composers/useComposerDraft";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";
import { useChannelPane } from "./ChannelPaneContext";
import { channelTaskItems, TaskDiff } from "./channelTaskItems";
import { WorkspacePreview } from "@workspace/components/outputs/WorkspacePreview";

/** Starts a message from elsewhere in the pane, continuing whatever draft exists. */
export type ChannelComposerHandle = {
  /** Addresses the draft to an agent by mentioning it first. */
  reply: (agent: Pick<ChannelAgent, "name">) => void;
  /** Begins a mention, so its menu can address or add an agent. */
  mention: () => void;
  focus: () => void;
};

/** The saved draft of the Channel's composer, or of one thread's. */
export function channelDraftKey(channelId: string, threadSequence?: number): DraftKey {
  return threadSequence === undefined
    ? `channel:${channelId}`
    : `channel:${channelId}:${threadSequence}`;
}

/** The draft with an agent's mention first, unless it already opens with it. */
export function addressedDraft(text: string, agent: Pick<ChannelAgent, "name">): string {
  const mention = `@${agentHandleFromName(agent.name)} `;
  return text.startsWith(mention) ? text : `${mention}${text}`;
}

export function ChannelComposer({
  channelId,
  threadSequence,
  state,
  handleRef,
  onSubmit,
  onShowRequest,
}: {
  channelId: string;
  /** Replies in this thread, in place of posting to the Channel. */
  threadSequence?: number;
  state?: ChannelState;
  handleRef: RefObject<ChannelComposerHandle | null>;
  onSubmit: (message: Pick<PostChannelMessageInput, "content" | "attachments">) => Promise<unknown>;
  onShowRequest?: () => void;
}) {
  const { revealFile, focusedPaneAtom } = useWorkspaceSurface();
  const channel = state?.channel;
  const diff = channelTasksDiff(channel?.tasks ?? []);
  const inThread = threadSequence !== undefined;
  const request = state?.request;
  const needsReply = channel ? channelHasPendingRequest(channel) : false;
  const { lead, members, agents } = useChannelPane();
  const artifacts = state?.artifacts
    .map(({ file, title, sharedAt }) => ({ file, label: title, time: Date.parse(sharedAt) }))
    .reverse();
  const draft = useComposerDraft({
    ...useSavedDraft(channelDraftKey(channelId, threadSequence)),
    onSend: onSubmit,
    disabled: !state,
  });
  const createMember = useMutation(channelMutations.createMember());
  // Delivery resolves the same audience, so this is exactly who the message will wake.
  const audience = resolveChannelAudience({
    content: draft.value,
    sender: { type: "user" },
    lead,
    members,
    acknowledgedRequest: needsReply,
  });

  useImperativeHandle(handleRef, () => ({
    reply: (agent) => {
      draft.setValue(addressedDraft(draft.value, agent));
      draft.focus();
    },
    mention: () => {
      const { value } = draft;
      draft.setValue(value === "" || /\s$/.test(value) ? `${value}@` : `${value} @`);
      draft.focus();
    },
    focus: draft.focus,
  }));

  function openArtifact(file: WorkspaceFile) {
    if (revealFile) revealFile(file);
    else focusedPaneAtom.set(createEditorPaneId(file));
  }

  return (
    <Composer
      draft={draft}
      tray={
        !inThread && (
          <ComposerTray
            artifacts={artifacts ?? []}
            checklist={channelTaskItems({
              tasks: channel?.tasks ?? [],
              owners: agents,
              artifacts: state?.artifacts ?? [],
              onArtifactOpen: ({ file }) => openArtifact(file),
              closeOnArtifactOpen: true,
            })}
            artifactTimeLabel="Shared"
            checklistLabel="Tasks"
            checklistHeaderDetail={diff && <TaskDiff diff={diff} />}
            extraOutput={channel?.preview && <WorkspacePreview preview={channel.preview} />}
            onOpenArtifact={openArtifact}
          />
        )
      }
      completions={{
        sources: [
          agentCompletionSource({
            lead,
            members,
            createMember: (name) => createMember.mutateAsync({ channelId, name }),
          }),
        ],
        menu: (completions) => <AgentCompletionMenu completions={completions} />,
      }}
      controls={
        <>
          <ChannelAudience audience={audience} agentCount={agents.length} />
          {request && onShowRequest && (
            <InputNeeded request={request.content} onShow={onShowRequest} />
          )}
        </>
      }
      actions={
        <ComposerSendButton draft={draft} label={inThread ? "Send reply" : "Send message"} />
      }
      label={inThread ? "Thread reply" : "Channel message"}
      placeholder={
        inThread
          ? "Reply in thread, or @mention an agent"
          : needsReply
            ? `Reply to ${lead.name}, or @mention an agent`
            : `Message ${channel ? `#${channel.name}` : "the channel"}, or @mention an agent`
      }
    />
  );
}

/** Who the draft will wake. Mentions that match no agent leave a posted message unheard. */
function ChannelAudience({
  audience,
  agentCount,
}: {
  audience: readonly ChannelAgent[];
  agentCount: number;
}) {
  const summary =
    audience.length === 0
      ? "No agent matches these mentions"
      : `Wakes ${audience.map(({ name }) => name).join(", ")}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={summary}
            className={cn(
              "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-muted px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
              audience.length === 0 && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          />
        }
      >
        {audience.length === 0 ? (
          "No one will be notified"
        ) : (
          <>
            To
            <span className="flex shrink-0 gap-0.5">
              {audience.map((agent) => (
                <AgentAvatar key={agent.id} agent={agent} className="size-4" />
              ))}
            </span>
            <span className="truncate font-medium text-foreground">
              {channelAudienceLabel(audience, agentCount)}
            </span>
          </>
        )}
      </TooltipTrigger>
      <TooltipContent sideOffset={6}>{summary}</TooltipContent>
    </Tooltip>
  );
}

/** The lead's pending question: hovering previews it, and clicking scrolls to it. */
function InputNeeded({ request, onShow }: { request: string; onShow: () => void }) {
  return (
    <PreviewCard>
      <PreviewCardTrigger
        render={<button type="button" />}
        onClick={onShow}
        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs hover:bg-muted"
      >
        <RunningIndicator waiting className="size-3.5" />
        Input needed
      </PreviewCardTrigger>
      <PreviewCardContent
        side="top"
        align="start"
        className="max-h-72 w-80 overflow-y-auto text-sm"
      >
        <AgentMentionMarkdown content={request} />
      </PreviewCardContent>
    </PreviewCard>
  );
}
