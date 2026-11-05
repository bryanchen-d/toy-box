import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { defaultRemarkPlugins, type Components } from "streamdown";
import { Markdown } from "@/shared/ui/markdown";
import { encodeReference } from "@/shared/references";
import { teamReference } from "@teams/model/references";
import { teamReferenceTags, remarkTeamReferences } from "./TeamReferences";

const components = {
  "team-reference": ({
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
      remarkPlugins={[...Object.values(defaultRemarkPlugins), remarkTeamReferences]}
      allowedTags={teamReferenceTags}
      components={components}
    >
      {content}
    </Markdown>,
  );
}

test("raw team, members, agent and message URIs render as references with punctuation outside", () => {
  const uris = [
    "team:release",
    "team:release/members",
    "team:release/agents/reviewer",
    "team:release/messages/42",
  ];
  const html = render(uris.map((uri) => `See ${uri}.`).join("\n"));
  for (const uri of uris) expect(html).toContain(`href="${uri}"`);
  expect(html).toContain("42</a>.");
});

test("Markdown references preserve escaped identity and display label", () => {
  const reference = teamReference(
    { type: "agent", teamId: "team/one", agentId: "critic % one" },
    "Reviewer",
  );
  const html = render(encodeReference(reference));
  expect(html).toContain('href="team:team%2Fone/agents/critic%20%25%20one"');
  expect(html).toContain(">Reviewer</a>");
});

test("code, ordinary links and malformed URIs are not interpreted as team references", () => {
  const source = "`team:release/members` [Other](https://example.com) team:release/messages/0";
  const html = render(source);
  expect(html).not.toContain('href="team:');
  expect(html).toBe(renderToStaticMarkup(<Markdown>{source}</Markdown>));
  expect(html).toContain("team:release/messages/0");
});
