import { AgentMentionMarkdown } from "@teams/components/agents/AgentMentionMarkdown";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "@/shared/ui/preview-card";
import { RunningIndicator } from "@/shared/ui/running-indicator";
import { useImperativeHandle, type RefObject } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AgentAvatar } from "@teams/components/agents/AgentAvatar";
import { AgentCompletionMenu } from "@teams/components/agents/AgentCompletionMenu";
import { agentCompletionSource } from "@teams/components/agents/agentCompletionSource";
import {
  agentHandleFromName,
  connectorAuthor,
  teamAudienceLabel,
  teamHasPendingRequest,
  teamTasksDiff,
  resolveTeamAudience,
  type TeamAgent,
  type TeamState,
  type PostTeamMessageInput,
} from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { connectorsAddressedBy } from "@connectors/model";
import { connectorQueries } from "@connectors/queries";
import { workspaceFileId } from "@files/model";
import { ComposerTray } from "@workspace/components/outputs/ComposerTray";
import { useSavedDraft } from "@workspace/hooks/useSavedDraft";
import type { DraftKey } from "@workspace/model/state/drafts";
import { Composer, ComposerSendButton } from "@/shared/composers/Composer";
import { useComposerDraft } from "@/shared/composers/useComposerDraft";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/shared/ui/tooltip";
import { cn } from "@/shared/utils";
import { useTeamPane } from "./TeamPaneContext";
import { teamTaskItems, TaskDiff } from "./teamTaskItems";
import { WorkspacePreview } from "@workspace/components/outputs/WorkspacePreview";
import type { ComposerReferences } from "@/shared/composers/input/ComposerInput";
import { parseTeamUri } from "@teams/model/references";

const teamReferences: ComposerReferences = (reference) =>
  reference.kind === "team" && parseTeamUri(`team:${reference.target}`)
    ? { title: `team:${reference.target}`, className: "rounded bg-accent/25 px-1 font-medium" }
    : undefined;

/** Starts a message from elsewhere in the pane, continuing whatever draft exists. */
export type TeamComposerHandle = {
  /** Addresses the draft to an agent by mentioning it first. */
  reply: (agent: Pick<TeamAgent, "name">) => void;
  /** Begins a mention, so its menu can address or add an agent. */
  mention: () => void;
  focus: () => void;
};

/** The saved draft of the Team's composer, or of one thread's. */
export function teamDraftKey(teamId: string, threadSequence?: number): DraftKey {
  return threadSequence === undefined ? `team:${teamId}` : `team:${teamId}:${threadSequence}`;
}

/** The draft with an agent's mention first, unless it already opens with it. */
export function addressedDraft(text: string, agent: Pick<TeamAgent, "name">): string {
  const mention = `@${agentHandleFromName(agent.name)} `;
  return text.startsWith(mention) ? text : `${mention}${text}`;
}

export function TeamComposer({
  teamId,
  threadSequence,
  state,
  handleRef,
  onSubmit,
  onShowRequest,
}: {
  teamId: string;
  /** Replies in this thread, in place of posting to the Team. */
  threadSequence?: number;
  state?: TeamState;
  handleRef: RefObject<TeamComposerHandle | null>;
  onSubmit: (message: Pick<PostTeamMessageInput, "content" | "attachments">) => Promise<unknown>;
  onShowRequest?: () => void;
}) {
  const team = state?.team;
  const diff = teamTasksDiff(team?.tasks ?? []);
  const inThread = threadSequence !== undefined;
  const request = state?.request;
  const needsReply = team ? teamHasPendingRequest(team) : false;
  const { lead, members, agents, openArtifact, openPanel } = useTeamPane();
  // The arrangement puts pins before new shares; archived artifacts stay off the tray.
  const artifacts = state?.artifacts.flatMap(({ file, title, sharedAt, archived, pinned }) =>
    archived ? [] : [{ file, label: title, time: Date.parse(sharedAt), pinned }],
  );
  const { mutate: arrangeArtifacts, error: arrangementError } = useMutation(
    teamMutations.arrangeArtifacts(teamId),
  );
  const draft = useComposerDraft({
    ...useSavedDraft(teamDraftKey(teamId, threadSequence)),
    onSend: onSubmit,
    disabled: !state,
  });
  const createMember = useMutation(teamMutations.createMember());
  const { data: connectors = [] } = useQuery(connectorQueries.list());
  // Delivery resolves the same audience, so this is exactly who the message will wake.
  const audience = resolveTeamAudience({
    content: draft.value,
    sender: { type: "user" },
    lead,
    members,
    acknowledgedRequest: needsReply,
  });
  const connectorRecipients = connectorsAddressedBy(draft.value, connectors).map(connectorAuthor);

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

  return (
    <Composer
      draft={draft}
      references={teamReferences}
      tray={
        !inThread && (
          <ComposerTray
            artifacts={artifacts ?? []}
            checklist={teamTaskItems({
              tasks: team?.tasks ?? [],
              owners: agents,
              artifacts: state?.artifacts ?? [],
              onArtifactOpen: ({ file }) => openArtifact(file),
              closeOnArtifactOpen: true,
            })}
            artifactTimeLabel="Shared"
            checklistLabel="Tasks"
            checklistHeaderDetail={diff && <TaskDiff diff={diff} />}
            extraOutput={team?.preview && <WorkspacePreview preview={team.preview} />}
            onOpenArtifact={openArtifact}
            onArchiveArtifact={(file) =>
              arrangeArtifacts({ artifactIds: [workspaceFileId(file)], archived: true })
            }
            onPinArtifact={(file, pinned) =>
              arrangeArtifacts({ artifactIds: [workspaceFileId(file)], pinned })
            }
            onManageArtifacts={() => openPanel("artifacts")}
          >
            {arrangementError && (
              <p role="alert" className="px-2 py-1 text-xs text-destructive">
                Unable to arrange artifacts: {arrangementError.message}
              </p>
            )}
          </ComposerTray>
        )
      }
      completions={{
        sources: [
          agentCompletionSource({
            lead,
            members,
            connectors,
            createMember: team?.paused
              ? undefined
              : (name) => createMember.mutateAsync({ teamId, name }),
          }),
        ],
        menu: (completions) => <AgentCompletionMenu completions={completions} />,
      }}
      controls={
        <>
          {team?.paused ? (
            <span className="text-xs text-muted-foreground" role="status">
              Team paused - Messages won't wake agents
            </span>
          ) : (
            <TeamAudience
              audience={audience}
              connectors={connectorRecipients}
              agentCount={agents.length}
            />
          )}
          {request && onShowRequest && (
            <InputNeeded request={request.content} onShow={onShowRequest} />
          )}
        </>
      }
      actions={
        <ComposerSendButton draft={draft} label={inThread ? "Send reply" : "Send message"} />
      }
      label={inThread ? "Thread reply" : "Team message"}
      placeholder={
        inThread
          ? "Reply in thread, or @mention an agent"
          : needsReply
            ? `Reply to ${lead.name}, or @mention an agent`
            : `Message ${team ? `#${team.name}` : "the team"}, or @mention an agent`
      }
    />
  );
}

/** Who the draft will wake or reach. Mentions that match no one leave a posted message unheard. */
function TeamAudience({
  audience,
  connectors,
  agentCount,
}: {
  audience: readonly TeamAgent[];
  /** Connectors the message opens by addressing, which receive it rather than wake. */
  connectors: readonly TeamAgent[];
  agentCount: number;
}) {
  const recipients = [...audience, ...connectors];
  const summary =
    recipients.length === 0
      ? "No agent or connector matches these mentions"
      : [
          audience.length > 0 && `Wakes ${audience.map(({ name }) => name).join(", ")}`,
          connectors.length > 0 && `Sends to ${connectors.map(({ name }) => name).join(", ")}`,
        ]
          .filter(Boolean)
          .join(". ");
  const label = [
    ...(audience.length > 0 ? [teamAudienceLabel(audience, agentCount)] : []),
    ...connectors.map(({ name }) => name),
  ].join(", ");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            aria-label={summary}
            className={cn(
              "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-muted px-2 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
              recipients.length === 0 && "bg-amber-500/10 text-amber-700 dark:text-amber-400",
            )}
          />
        }
      >
        {recipients.length === 0 ? (
          "No one will be notified"
        ) : (
          <>
            To
            <span className="flex shrink-0 gap-0.5">
              {recipients.map((agent) => (
                <AgentAvatar key={agent.id} agent={agent} className="size-4" />
              ))}
            </span>
            <span className="truncate font-medium text-foreground">{label}</span>
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
