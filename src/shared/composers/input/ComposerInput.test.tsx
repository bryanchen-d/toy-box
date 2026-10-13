import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerInput } from "./ComposerInput";

test("server markup cannot accept edits before hydration attaches the native input", () => {
  const markup = renderToStaticMarkup(
    <ComposerInput value="" onValueChange={() => {}} placeholder="Write a message" />,
  );
  expect(markup).toMatch(/contenteditable="false"/i);
  expect(markup).toContain('aria-disabled="true"');
  expect(markup).toContain('data-placeholder="Write a message"');
  expect(markup).toContain('data-empty="true"');
  expect(markup).not.toContain(">Write a message<");
});
