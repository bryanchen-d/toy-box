import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  channelAgentIdentity,
  channelLead,
  type ChannelConversationMessage,
} from "@channels/model";
import { ChannelPaneProvider } from "../ChannelPaneContext";
import { ThreadActivity, ThreadSummary } from "./ThreadReplies";
import type { TranscriptThread } from "./transcriptRows";

const lead = channelLead("channel");
const root: ChannelConversationMessage = {
  id: "root",
  sequence: 1,
  timestamp: "2026-11-02T10:00:00Z",
  sender: { type: "agent", agentId: lead.id },
  content: "Release plan",
};
const reply: ChannelConversationMessage = {
  id: "reply",
  sequence: 2,
  threadSequence: root.sequence,
  timestamp: "2026-11-02T10:01:00Z",
  sender: { type: "user" },
  content: "Looks good",
};
const thread: TranscriptThread = { sequence: root.sequence, replies: [reply] };

function render(content: ReactNode): string {
  const noop = () => {};
  return renderToStaticMarkup(
    <ChannelPaneProvider
      value={{
        lead,
        members: [],
        agents: [lead],
        agent: (id) => channelAgentIdentity([lead], id),
        presence: {},
        openThread: noop,
        replyInThread: noop,
        isSending: () => false,
        mention: noop,
        openArtifact: noop,
        openArtifacts: noop,
      }}
    >
      {content}
    </ChannelPaneProvider>,
  );
}

test("a human thread reply is right-aligned and blue while keeping its thread context", () => {
  const html = render(<ThreadActivity thread={thread} root={root} />);

  expect(html).toMatch(/^<button[^>]+class="[^"]*justify-end/);
  expect(html).toContain("user-message");
  expect(html).not.toContain("border-dashed");
  expect(html).toContain("1 reply in thread");
  expect(html).toContain("Release plan");
  expect(html).toContain("You:</span> Looks good");
});

test("the latest author determines activity styling, leaving agent replies on the left", () => {
  const html = render(
    <ThreadActivity
      thread={{
        ...thread,
        replies: [
          reply,
          { ...reply, id: "agent-reply", sequence: 3, sender: root.sender, content: "Shipping" },
        ],
      }}
      root={root}
    />,
  );

  expect(html).not.toContain("justify-end");
  expect(html).not.toContain("user-message");
  expect(html).toContain("border-dashed");
  expect(html).toContain("2 replies in thread");
  expect(html).toContain(`${lead.name}:</span> Shipping`);
});

test("human participants are blue in thread summaries", () => {
  const html = render(<ThreadSummary thread={thread} />);

  expect(html).toContain("bg-blue-100 text-blue-950");
  expect(html).toContain("1 reply");
});

test("an attachment-only human reply keeps its blue activity and attachment summary", () => {
  const html = render(
    <ThreadActivity
      thread={{
        ...thread,
        replies: [
          {
            ...reply,
            content: "",
            attachments: [{ name: "screenshot.png", url: "/screenshot.png" }],
          },
        ],
      }}
    />,
  );

  expect(html).toContain("justify-end");
  expect(html).toContain("user-message");
  expect(html).toContain("Shared an attachment");
});
