import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { UserMessage } from "./UserMessage";

test("human messages use a right-aligned blue bubble with readable Markdown", () => {
  const html = renderToStaticMarkup(
    <UserMessage
      message={{ content: "First line\n[Link](https://example.com) and `code`" }}
      time={<span>10:00</span>}
    />,
  );

  expect(html).toContain("flex flex-col items-end");
  expect(html).toContain('class="user-message ');
  expect(html).toContain('data-streamdown="link"');
  expect(html).toContain('data-streamdown="inline-code"');
  expect(html).toContain("<br");
  expect(html).toContain('aria-label="Copy message"');
  expect(html).toContain("10:00");
});
