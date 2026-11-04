import type { RefObject } from "react";
import { MessageSearch } from "@/shared/messages/MessageSearch";
import { sessionQueries } from "../../queries";
import type { SessionMessageMatch } from "../../model/search";

export function SessionMessageSearch({
  sessionId,
  ...props
}: {
  sessionId: string;
  isVisible: boolean;
  hotkeyTarget: RefObject<HTMLElement | null>;
  onSelect: (match: SessionMessageMatch) => void;
}) {
  return (
    <MessageSearch
      {...props}
      queries={(query) => sessionQueries.search(sessionId, query)}
      getKey={(match) => match.messageIndex}
      getLabel={(match) => match.role}
    />
  );
}
