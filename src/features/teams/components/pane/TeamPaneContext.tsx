import { createContext, useContext } from "react";
import type {
  TeamAgent,
  TeamAgentIdentity,
  TeamConversationMessage,
  TeamLead,
  TeamMember,
} from "@teams/model";
import type { TeamAgentPresence } from "@teams/model/presence";
import type { WorkspaceFile } from "@files/model";
import type { TeamPanel } from "./panels";

/** The open Team's agents, its threads and artifacts, and the drafts its transcript and
 *  overview start. */
type TeamPane = {
  teamId: string;
  selectedMessageSequence?: number;
  lead: TeamLead;
  members: readonly TeamMember[];
  /** The lead, then the members. */
  agents: readonly TeamAgent[];
  /** The agent or connector with this ID, or a deleted identity once it has left. */
  agent: (id: string) => TeamAgentIdentity;
  presence: Record<string, TeamAgentPresence>;
  /** Shows a thread by its top-level message's sequence. */
  openThread: (sequence: number) => void;
  /** Answers a message in its thread, addressing the draft to the agent who wrote it. */
  replyInThread: (message: TeamConversationMessage) => void;
  /** A message still being sent has no committed sequence to reply to yet. */
  isSending: (messageId: string) => boolean;
  /** Begins a mention, so the picker can address or add an agent. */
  mention: () => void;
  /** Brings a shared artifact's editor forward, opening it when it isn't showing. */
  openArtifact: (file: WorkspaceFile) => void;
  /** Shows one of the Team's panels beside chat, as its panel bar button would. */
  openPanel: (panel: TeamPanel) => void;
};

const TeamPaneContext = createContext<TeamPane | undefined>(undefined);

export const TeamPaneProvider = TeamPaneContext.Provider;

/** The open Team's roster, available from the first render, as the lead is intrinsic. */
export function useTeamPane(): TeamPane {
  const pane = useContext(TeamPaneContext);
  if (!pane) throw new Error("Team content must be rendered within a Team pane.");
  return pane;
}
