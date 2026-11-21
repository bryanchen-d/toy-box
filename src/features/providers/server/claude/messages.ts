import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SessionEvent, SessionMessage } from "@sessions/model";
import type { Attachment } from "@/shared/attachments/model";
import {
  decodeSystemMessage,
  encodeSystemMessage,
  systemMessagePrompt,
} from "@sessions/model/systemMessages";

type Content = Extract<SDKUserMessage["message"], { role: "user" }>["content"];

/** Image inputs and structured notifications live in Claude's native transcript. */
export function encodeInput(message: SessionMessage): Content {
  if (message.role === "system")
    return [
      { type: "text", text: encodeSystemMessage(message.content) },
      { type: "text", text: systemMessagePrompt(message.content) },
    ];

  const content: Exclude<Content, string> = [];
  if (message.content) content.push({ type: "text", text: message.content });
  for (const { mimeType, base64: data } of message.attachments ?? []) {
    if (
      mimeType === "image/jpeg" ||
      mimeType === "image/png" ||
      mimeType === "image/gif" ||
      mimeType === "image/webp"
    ) {
      content.push({ type: "image", source: { type: "base64", media_type: mimeType, data } });
    } else {
      throw new Error("Claude Agent supports PNG, JPEG, GIF, and WebP images.");
    }
  }
  return content;
}

export function decodeInput(content: Content, clientId?: string, timestamp?: string): SessionEvent {
  const blocks = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
  const first = blocks[0];
  const system = first?.type === "text" ? decodeSystemMessage(first.text) : undefined;
  if (system) return { type: "system_message", content: system, clientId, timestamp };

  const text: string[] = [];
  const attachments: Attachment[] = [];
  for (const block of blocks) {
    if (block.type === "text") text.push(block.text);
    if (block.type === "image" && block.source.type === "base64")
      attachments.push({ mimeType: block.source.media_type, base64: block.source.data });
  }
  return {
    type: "user_message",
    content: displayPrompt(text.join("\n")),
    clientId,
    timestamp,
    // Claude exposes file rewind and resume-at branching, not an in-place conversation rewind.
    rewindable: false,
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Claude records skill and local command invocations, such as `/cost`, as command markup. */
function displayPrompt(text: string): string {
  const tags = /<command-(name|message|args)>([\s\S]*?)<\/command-\1>/g;
  const command = Object.fromEntries(
    [...text.matchAll(tags)].map(([, tag, value]) => [tag, value]),
  );
  if (!command.name || text.replace(tags, "").trim()) return text;
  return [command.name, command.args].filter(Boolean).join(" ");
}
