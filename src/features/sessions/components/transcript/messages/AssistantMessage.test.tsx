import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AssistantMessage } from "./AssistantMessage";
import { StatusIndicator } from "../SessionStatus";

test("a live background session displays a static background status instead of responding", () => {
  const markup = renderToStaticMarkup(<StatusIndicator status="background" />);
  expect(markup).toContain("Background tasks running");
  expect(markup).toContain("lucide-layers");
  expect(markup).not.toContain("Responding");
});

test.each(["", "Partial answer"])(
  "renders an error card alongside assistant content %j",
  (content) => {
    const markup = renderToStaticMarkup(
      <AssistantMessage
        message={{
          role: "assistant",
          content,
          error:
            "**Usage limit exceeded.** Visit https://example.com/usage or [get help](https://example.com/help).",
        }}
        isStreaming={false}
        isLast
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("lucide-triangle-alert");
    expect(markup).toContain('data-streamdown="strong">Usage limit exceeded.');
    expect(markup).toContain('href="https://example.com/usage"');
    expect(markup).toContain('href="https://example.com/help"');
    if (content) {
      expect(markup).toContain(content);
      expect(markup.indexOf(content)).toBeLessThan(markup.indexOf('role="alert"'));
    }
  },
);
