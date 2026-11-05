import type { RefObject } from "react";
import { teamQueries } from "@teams/queries";
import type { TeamMessageMatch } from "@teams/model/search";
import { MessageSearch } from "@/shared/messages/MessageSearch";
import { useTeamPane } from "./TeamPaneContext";

export function TeamMessageSearch({
  teamId,
  threadSequence,
  ...props
}: {
  teamId: string;
  threadSequence?: number;
  isVisible: boolean;
  hotkeyTarget: RefObject<HTMLElement | null>;
  onSelect: (match: TeamMessageMatch) => void;
}) {
  const { agent } = useTeamPane();
  return (
    <MessageSearch
      {...props}
      queries={(query) => teamQueries.search(teamId, query, threadSequence)}
      getKey={(match) => match.sequence}
      getLabel={(match) =>
        match.sender.type === "user" ? "You" : agent(match.sender.agentId).name
      }
      placeholder={threadSequence === undefined ? "Search this team..." : "Search this thread..."}
    />
  );
}
