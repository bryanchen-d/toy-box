import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TeamAdvice } from "@teams/model/advice";
import { TeamPanelBar } from "./TeamPanelBar";
import { TEAM_PANELS, teamPanelAlerts } from "./panels";

const noop = () => {};

test.each(["normal", "compact"] as const)(
  "the %s panel bar starts with an open toggle when no aside is shown",
  (variant) => {
    const html = renderToStaticMarkup(
      <TeamPanelBar
        panel={undefined}
        asideOpen={false}
        hasCanvas={false}
        alerts={new Set()}
        variant={variant}
        onToggle={noop}
        onToggleAside={noop}
      />,
    );
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;

    expect(buttons).toHaveLength(TEAM_PANELS.length + 1);
    expect(buttons[0]).toContain('aria-label="Open panel"');
    expect(buttons[0]).toContain('aria-expanded="false"');
    expect(buttons[0]).not.toContain("aria-keyshortcuts");
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
        alerts={new Set()}
        variant="normal"
        onToggle={noop}
        onToggleAside={noop}
      />,
    );
    const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;

    expect(buttons[0]).toContain('aria-label="Close panel"');
    expect(buttons[0]).toContain('aria-expanded="true"');
    expect(buttons[0]).toContain('aria-keyshortcuts="Escape"');
    expect(buttons[0]).toContain("lucide-panel-right-close");
    expect(html.match(/aria-pressed="true"/g) ?? []).toHaveLength(panel ? 1 : 0);
    if (panel) {
      expect(buttons[TEAM_PANELS.indexOf(panel) + 1]).toContain('aria-pressed="true"');
    }
  },
);

test("a panel that needs review is marked on its toggle", () => {
  const html = renderToStaticMarkup(
    <TeamPanelBar
      panel={undefined}
      asideOpen={false}
      hasCanvas
      alerts={new Set(["security"] as const)}
      variant="normal"
      onToggle={noop}
      onToggleAside={noop}
    />,
  );
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;

  expect(buttons[TEAM_PANELS.indexOf("security") + 1]).toContain(
    'aria-label="Security, needs review"',
  );
  expect(html.match(/needs review/g)).toHaveLength(1);
});

test.each(["normal", "compact"] as const)(
  "the %s performance toggle stays marked until every advice is resolved",
  (variant) => {
    const advice: TeamAdvice = {
      id: "advice",
      authorId: "auditor",
      title: "Reduce duplicate work",
      finding: "Two agents repeat the same checks.",
      action: { type: "message_lead", content: "Assign each check to one agent." },
      status: "open",
      createdAt: "2026-11-18T00:00:00Z",
    };

    for (const statuses of [
      [],
      ["open"],
      ["applied", "open", "dismissed"],
      ["applied", "dismissed"],
    ] satisfies TeamAdvice["status"][][]) {
      const items = statuses.map((status, index) => ({ ...advice, id: `${index}`, status }));
      const html = renderToStaticMarkup(
        <TeamPanelBar
          panel="performance"
          asideOpen
          hasCanvas
          alerts={teamPanelAlerts(items, true)}
          variant={variant}
          onToggle={noop}
          onToggleAside={noop}
        />,
      );
      const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)!;
      const performance = buttons[TEAM_PANELS.indexOf("performance") + 1]!;

      expect(performance.includes('aria-label="Performance, needs review"')).toBe(
        statuses.includes("open"),
      );
      expect(performance.includes("bg-destructive")).toBe(statuses.includes("open"));
      expect(buttons[TEAM_PANELS.indexOf("security") + 1]).toContain(
        'aria-label="Security, needs review"',
      );
    }
  },
);
