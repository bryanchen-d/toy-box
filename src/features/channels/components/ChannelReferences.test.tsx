import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { defaultRemarkPlugins, type Components } from "streamdown";
import { Markdown } from "@/shared/ui/markdown";
import { encodeReference } from "@/shared/references";
import { channelReference } from "@channels/model/references";
import { channelReferenceTags, remarkChannelReferences } from "./ChannelReferences";

const components = {
  "channel-reference": ({
    uri,
    children,
  }: {
    [key: string]: unknown;
    uri?: string;
    children?: ReactNode;
  }) => <a href={uri}>{children}</a>,
} satisfies Components;

function render(content: string) {
  return renderToStaticMarkup(
    <Markdown
      remarkPlugins={[...Object.values(defaultRemarkPlugins), remarkChannelReferences]}
      allowedTags={channelReferenceTags}
      components={components}
    >
      {content}
    </Markdown>,
  );
}

test("raw channel, team, agent and message URIs render as references with punctuation outside", () => {
  const uris = [
    "channel:release",
    "channel:release/team",
    "channel:release/agents/reviewer",
    "channel:release/messages/42",
  ];
  const html = render(uris.map((uri) => `See ${uri}.`).join("\n"));
  for (const uri of uris) expect(html).toContain(`href="${uri}"`);
  expect(html).toContain("42</a>.");
});

test("Markdown references preserve escaped identity and display label", () => {
  const reference = channelReference(
    { type: "agent", channelId: "team/one", agentId: "critic % one" },
    "Reviewer",
  );
  const html = render(encodeReference(reference));
  expect(html).toContain('href="channel:team%2Fone/agents/critic%20%25%20one"');
  expect(html).toContain(">Reviewer</a>");
});

test("code, ordinary links and malformed URIs are not interpreted as channel references", () => {
  const source = "`channel:release/team` [Other](https://example.com) channel:release/messages/0";
  const html = render(source);
  expect(html).not.toContain('href="channel:');
  expect(html).toBe(renderToStaticMarkup(<Markdown>{source}</Markdown>));
  expect(html).toContain("channel:release/messages/0");
});
