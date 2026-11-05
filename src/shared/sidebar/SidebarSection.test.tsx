import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarSection } from "./SidebarSection";

test("a section counts what it holds and folds any body, not only a list", () => {
  const expanded = renderToStaticMarkup(
    <SidebarSection title="Sessions" count={12} isExpanded onExpandedChange={() => {}} fill>
      <input aria-label="Filter sessions" />
      <p>Rows</p>
    </SidebarSection>,
  );
  const collapsed = renderToStaticMarkup(
    <SidebarSection title="Sessions" count={0} isExpanded={false} onExpandedChange={() => {}}>
      <p>Rows</p>
    </SidebarSection>,
  );

  expect(expanded).toContain(">Sessions</span>");
  expect(expanded).toContain(">12</span>");
  expect(expanded).toContain('aria-label="Filter sessions"');
  expect(expanded).toContain('aria-label="Collapse sessions"');
  expect(collapsed).toContain('aria-label="Expand sessions"');
  expect(collapsed).toContain('aria-hidden="true"');
  expect(collapsed).not.toContain(">0</span>");
});
