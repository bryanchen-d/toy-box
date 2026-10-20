import type { Message as SessionTranscriptMessage } from "../../../model";
import { AssistantMessage } from "./AssistantMessage";
import { SessionUserMessage } from "./SessionUserMessage";
import { SystemMessage } from "./SystemMessage";

type MessageProps = {
  message: SessionTranscriptMessage;
  isStreaming: boolean;
  isBusy?: boolean;
  isLast: boolean;
};

export function Message({ message, isStreaming, isBusy = isStreaming, isLast }: MessageProps) {
  if (message.role === "user") return <SessionUserMessage message={message} />;
  if (message.role === "system") return <SystemMessage message={message} />;
  return (
    <AssistantMessage message={message} isStreaming={isStreaming} isBusy={isBusy} isLast={isLast} />
  );
}
