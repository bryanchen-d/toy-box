import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMentionMarkdown } from "./AgentMentionMarkdown";

describe("AgentMentionMarkdown", () => {
  test("decorates mentions in prose but not code or links", () => {
    const markup = renderToStaticMarkup(
      <AgentMentionMarkdown content="Ask **@critic**, not `@builder` or [@planner](https://example.com)." />,
    );

    expect(markup.match(/data-agent-mention="[^"]+"/g)).toEqual(['data-agent-mention="critic"']);
  });
});
