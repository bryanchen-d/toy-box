import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextMeter } from "./ContextMeter";

const render = (tokens: number) =>
  renderToStaticMarkup(createElement(ContextMeter, { usage: { tokens, tokenWindow: 200_000 } }));

test("the meter appears only once the context window is more than half full", () => {
  expect(render(100_000)).toBe("");
  expect(render(120_000)).toContain('aria-label="Context window 60% full"');
});
