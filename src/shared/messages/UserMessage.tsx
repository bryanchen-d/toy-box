import type { ReactNode } from "react";
import { Markdown } from "@/shared/ui/markdown";
import { RelativeTime } from "@/shared/ui/relative-time";
import { Separator } from "@/shared/ui/separator";
import { AttachmentGallery } from "@/shared/attachments/AttachmentGallery";
import type { Attachment, AttachmentReference } from "@/shared/attachments/model";
import { CopyControl } from "./CopyControl";

export function UserMessage({
  message,
  extraActions,
  time,
  children,
}: {
  message: {
    content: string;
    timestamp?: string;
    attachments?: (Attachment | AttachmentReference)[];
  };
  /** Actions before Copy, separated from it whenever they render anything. */
  extraActions?: ReactNode;
  /** Replaces the relative timestamp, such as in a timeline already divided by day. */
  time?: ReactNode;
  children?: ReactNode;
}) {
  const attachments = message.attachments ?? [];

  return (
    <div className="flex flex-col items-end gap-2">
      {message.content && (
        <div className="max-w-full @md:max-w-[80%] rounded-lg bg-primary px-3 py-2.5 text-sm text-primary-foreground [&_[data-streamdown=link]]:text-primary-foreground [&_[data-streamdown=inline-code]]:bg-primary-foreground/15">
          {children ?? <Markdown preserveLineBreaks>{message.content}</Markdown>}
        </div>
      )}
      <div className="flex min-h-6 items-center gap-1">
        {extraActions && (
          <>
            <span className="peer flex items-center gap-1 empty:hidden">{extraActions}</span>
            <Separator orientation="vertical" className="h-4! peer-empty:hidden" />
          </>
        )}
        <CopyControl content={message.content} />
        {time ??
          (message.timestamp && (
            <RelativeTime className="text-xs text-muted-foreground" date={message.timestamp} />
          ))}
      </div>
      {attachments.length > 0 && (
        <div className="flex gap-1 flex-wrap justify-end max-w-full @md:max-w-[80%]">
          <AttachmentGallery attachments={attachments} />
        </div>
      )}
    </div>
  );
}
