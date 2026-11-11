import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { defaultRemarkPlugins } from "streamdown";
import { Markdown } from "@/shared/ui/markdown";
import { encodeReference } from "@/shared/references";
import { teamReference } from "@teams/model/references";
import { teamReferenceComponents, teamReferenceTags, remarkTeamReferences } from "./TeamReferences";

function render(content: string) {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <Markdown
        remarkPlugins={[...Object.values(defaultRemarkPlugins), remarkTeamReferences]}
        allowedTags={teamReferenceTags}
        components={teamReferenceComponents}
      >
        {content}
      </Markdown>
    </RouterContextProvider>,
  );
}

test("bare references have readable labels and in-app destinations with punctuation outside", () => {
  const uris = [
    "team:release",
    "team:release/members",
    "team:release/agents/reviewer",
    "team:release/messages/42",
  ];
  const html = render(uris.map((uri) => `See ${uri}.`).join("\n"));
  for (const uri of uris)
    expect(html).toContain(`href="/?teams=%5B%22release%22%5D#${encodeURIComponent(uri)}"`);
  expect(html).toContain(">Team release</span>");
  expect(html).toContain(">Team members</span>");
  expect(html).toContain(">Agent reviewer</span>");
  expect(html).toContain(">Message #42</span></a>.");
  expect(html).not.toContain('target="_blank"');
});

test("Markdown references preserve escaped identity and display label", () => {
  const reference = teamReference(
    { type: "agent", teamId: "team/one", agentId: "critic % one" },
    "Reviewer",
  );
  const html = render(encodeReference(reference));
  expect(html).toContain('title="team:team%2Fone/agents/critic%20%25%20one"');
  expect(html).toContain(
    'href="/?teams=%5B%22team%2Fone%22%5D#team%3Ateam%252Fone%2Fagents%2Fcritic%2520%2525%2520one"',
  );
  expect(html).toContain(">Reviewer</span>");
});

test("code, ordinary links and malformed URIs are not interpreted as team references", () => {
  const source = "`team:release/members` [Other](https://example.com) team:release/messages/0";
  const html = render(source);
  expect(html).not.toContain('href="team:');
  expect(html).toBe(renderToStaticMarkup(<Markdown>{source}</Markdown>));
  expect(html).toContain("team:release/messages/0");
});
