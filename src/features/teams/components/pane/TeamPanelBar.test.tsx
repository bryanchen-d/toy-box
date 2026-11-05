import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamPanelBar } from "./TeamPanelBar";
import { TEAM_PANELS } from "./panels";

const noop = () => {};

test.each(["normal", "compact"] as const)(
  "the %s panel bar starts with an open toggle when no aside is shown",
  (variant) => {
    const html = renderToStaticMarkup(
      <TeamPanelBar
        panel={undefined}
        asideOpen={false}
        hasCanvas={false}
        variant={variant}
        onToggle={noop}
        onToggleAside={noop}
      />,
    );
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;

    expect(buttons).toHaveLength(TEAM_PANELS.length + 1);
    expect(buttons[0]).toContain('aria-label="Open panel"');
    expect(buttons[0]).toContain('aria-expanded="false"');
    expect(buttons[0]).toContain("lucide-panel-right-open");
    expect(buttons[1]).toContain('aria-label="Overview"');
    expect(buttons[2]).toContain('aria-label="Canvas"');
    expect(buttons[2]).toContain('aria-disabled="true"');
    expect(html).not.toContain('aria-pressed="true"');
  },
);

test.each([...TEAM_PANELS, "thread"] as const)(
  "the close toggle reflects a visible %s aside",
  (aside) => {
    const panel = aside === "thread" ? undefined : aside;
    const html = renderToStaticMarkup(
      <TeamPanelBar
        panel={panel}
        asideOpen
        hasCanvas
        variant="normal"
        onToggle={noop}
        onToggleAside={noop}
      />,
    );
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;

    expect(buttons[0]).toContain('aria-label="Close panel"');
    expect(buttons[0]).toContain('aria-expanded="true"');
    expect(buttons[0]).toContain("lucide-panel-right-close");
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(panel ? 1 : 0);
    if (panel) {
      expect(buttons[TEAM_PANELS.indexOf(panel) + 1]).toContain('aria-pressed="true"');
    }
  },
);
