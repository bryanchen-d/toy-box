import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { MarkdownLink } from "@/shared/ui/markdown";
import { transcriptRehypePlugins } from "./TranscriptFileLink";

const testLinkComponents = { a: MarkdownLink };

describe("transcript artifact links", () => {
  test("preserves relative links while sanitizing unsafe URLs", () => {
    const markup = renderToStaticMarkup(
      <Streamdown
        mode="static"
        components={testLinkComponents}
        rehypePlugins={transcriptRehypePlugins}
      >
        {
          "Open [the artifact](nested/report.brief), [the docs](https://example.com), and [unsafe](javascript:alert(1))."
        }
      </Streamdown>,
    );

    expect(markup).toContain('href="nested/report.brief"');
    expect(markup).toContain('href="https://example.com"');
    expect(markup.match(/target="_blank"/g)).toHaveLength(1);
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("[blocked]");
    expect(markup).not.toContain("javascript:");
  });
});
