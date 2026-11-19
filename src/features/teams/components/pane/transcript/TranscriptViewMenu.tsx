import { MessageCircleQuestionMark, MessagesSquare, UserRound } from "lucide-react";
import { ViewMenu, type ViewOption } from "../ViewMenu";
import type { TranscriptView } from "./transcriptRows";

const VIEWS: ViewOption<TranscriptView>[] = [
  { value: "all", label: "All messages", Icon: MessagesSquare },
  { value: "yours", label: "Your messages", Icon: UserRound },
  { value: "requests", label: "Needs your reply", Icon: MessageCircleQuestionMark },
];

/** Chooses which messages the transcript shows. */
export function TranscriptViewMenu({
  view,
  onViewChange,
}: {
  view: TranscriptView;
  onViewChange: (view: TranscriptView) => void;
}) {
  return <ViewMenu name="Message view" views={VIEWS} view={view} onViewChange={onViewChange} />;
}
