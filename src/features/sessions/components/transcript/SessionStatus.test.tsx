import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionStatus } from "../../model";
import { StatusIndicator } from "./SessionStatus";

test.each([
  ["thinking", "Thinking"],
  ["reasoning", "Reasoning"],
  ["responding", "Responding"],
  ["compacting", "Compacting"],
  ["background", "Background tasks running"],
] satisfies [SessionStatus, string][])(
  "activity identifies its model during %s",
  (status, label) => {
    const html = renderToStaticMarkup(
      <StatusIndicator
        status={status}
        model={{ provider: "copilot", name: "claude-opus-5.5", reasoningEffort: "high" }}
      />,
    );
    expect(html).toContain(`claude-opus-5.5 (High): ${label}`);
  },
);

test("activity without a reported model keeps its existing label", () => {
  const html = renderToStaticMarkup(<StatusIndicator status="thinking" />);
  expect(html).toContain("Thinking");
  expect(html).not.toContain("undefined");
  expect(html).not.toContain(": Thinking");
});
