import type { RefObject } from "react";
import { channelQueries } from "@channels/queries";
import type { ChannelMessageMatch } from "@channels/model/search";
import { MessageSearch } from "@/shared/messages/MessageSearch";
import { useChannelPane } from "./ChannelPaneContext";

export function ChannelMessageSearch({
  channelId,
  threadSequence,
  ...props
}: {
  channelId: string;
  threadSequence?: number;
  isVisible: boolean;
  hotkeyTarget: RefObject<HTMLElement | null>;
  onSelect: (match: ChannelMessageMatch) => void;
}) {
  const { agent } = useChannelPane();
  return (
    <MessageSearch
      {...props}
      queries={(query) => channelQueries.search(channelId, query, threadSequence)}
      getKey={(match) => match.sequence}
      getLabel={(match) =>
        match.sender.type === "user" ? "You" : agent(match.sender.agentId).name
      }
      placeholder={
        threadSequence === undefined ? "Search this channel..." : "Search this thread..."
      }
    />
  );
}
