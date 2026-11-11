import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { InlineMarkdown, Markdown } from "./markdown";

test.each(["static", "streaming"] as const)(
  "%s Markdown opens website links directly in a new tab",
  (mode) => {
    const html = renderToStaticMarkup(
      <Markdown mode={mode}>{"[Docs](https://example.com) and https://example.org"}</Markdown>,
    );
    expect(html).toContain('href="https://example.com/"');
    expect(html).toContain('href="https://example.org/"');
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(html).not.toContain("<button");
  },
);

test("unsafe URLs and incomplete streaming links are not actionable", () => {
  const html = renderToStaticMarkup(
    <Markdown mode="streaming">{"[Unsafe](javascript:alert(1)) and [incomplete]("}</Markdown>,
  );
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain('href="streamdown:');
  expect(html).not.toContain("<a ");
});

test("inline Markdown shares website link behavior without changing local links or literal code", () => {
  const html = renderToStaticMarkup(
    <InlineMarkdown>
      {"[Docs](https://example.com) [Local](#section) `https://example.org`"}
    </InlineMarkdown>,
  );
  expect(html).toContain('href="https://example.com" target="_blank" rel="noopener noreferrer"');
  expect(html).toContain('href="#section" data-streamdown="link"');
  expect(html).toContain(">https://example.org</code>");
  expect(
    renderToStaticMarkup(
      <InlineMarkdown allowLinks={false}>{"[Docs](https://example.com)"}</InlineMarkdown>,
    ),
  ).toBe("Docs");
});

test("website query strings are not decoded as HTML entities a second time", () => {
  const html = renderToStaticMarkup(
    <Markdown>{"[Search](https://example.com/?name=one&copy=two)"}</Markdown>,
  );
  expect(html).toContain('href="https://example.com/?name=one&amp;copy=two"');
});
