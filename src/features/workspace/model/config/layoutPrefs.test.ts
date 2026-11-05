import { describe, expect, test } from "bun:test";
import {
  compactSidebarPanels,
  readWorkspaceLayout,
  serializeWorkspaceLayout,
  setSidebarPanelExpanded,
} from "./layoutPrefs";

const defaultLayout = {
  sidebarWidth: 280,
  terminalSize: 30,
  sidebarCollapsed: false,
  terminalOpen: false,
  panels: { teams: true, sessions: true, apps: false, automations: false },
  hyperOpen: false,
  hyperPosition: { x: 24, y: 24 },
  teamAsideSizes: {},
};

function cookieFor(value: unknown): string {
  return `agent_teams_layout=${encodeURIComponent(JSON.stringify(value))}`;
}

function cookieValue(cookie: string): unknown {
  const value = cookie.slice(cookie.indexOf("=") + 1, cookie.indexOf(";"));
  return JSON.parse(decodeURIComponent(value));
}

describe("workspace layout", () => {
  test("uses product defaults when no preferences are stored", () => {
    expect(readWorkspaceLayout()).toEqual(defaultLayout);
    expect(cookieValue(serializeWorkspaceLayout(defaultLayout))).toEqual({});
  });

  test("round-trips one cookie containing only non-default preferences", () => {
    const cookie = serializeWorkspaceLayout({
      ...defaultLayout,
      sidebarWidth: 320,
      terminalSize: 42,
      sidebarCollapsed: true,
      terminalOpen: true,
      panels: { teams: true, sessions: false, apps: true, automations: false },
      hyperOpen: true,
      hyperPosition: { x: 120, y: 80 },
      teamPanel: "tasks",
      teamAsideSizes: { thread: 40 },
    });

    expect(cookieValue(cookie)).toEqual({
      sidebarWidth: 320,
      terminalSize: 42,
      sidebarCollapsed: true,
      terminalOpen: true,
      panels: { sessions: false, apps: true },
      hyperOpen: true,
      hyperPosition: { x: 120, y: 80 },
      teamPanel: "tasks",
      teamAsideSizes: { thread: 40 },
    });
    expect(readWorkspaceLayout(`other=value; ${cookie}`)).toEqual({
      sidebarWidth: 320,
      terminalSize: 42,
      sidebarCollapsed: true,
      terminalOpen: true,
      panels: { teams: true, sessions: false, apps: true, automations: false },
      hyperOpen: true,
      hyperPosition: { x: 120, y: 80 },
      teamPanel: "tasks",
      teamAsideSizes: { thread: 40 },
    });
  });

  test("validates stored layout and clamps dimensions", () => {
    expect(
      readWorkspaceLayout(
        cookieFor({
          sidebarWidth: 9999,
          terminalSize: 999,
          teamAsideSizes: { canvas: 99, thread: 5 },
        }),
      ),
    ).toMatchObject({
      sidebarWidth: 480,
      terminalSize: 80,
      teamAsideSizes: { canvas: 75, thread: 25 },
    });
    expect(readWorkspaceLayout("agent_teams_layout=%")).toEqual(defaultLayout);
  });
});

describe("sidebar panels", () => {
  const panels = { teams: true, sessions: true, apps: false, automations: true };

  test("open and close independently on desktop", () => {
    expect(setSidebarPanelExpanded(panels, "apps", true, false)).toEqual({ ...panels, apps: true });
    expect(setSidebarPanelExpanded(panels, "teams", false, false)).toEqual({
      ...panels,
      teams: false,
    });
  });

  test("a compact sidebar opens one panel at a time", () => {
    expect(setSidebarPanelExpanded(panels, "apps", true, true)).toEqual({
      teams: false,
      sessions: false,
      apps: true,
      automations: false,
    });
    expect(setSidebarPanelExpanded(panels, "teams", false, true)).toEqual({
      teams: false,
      sessions: false,
      apps: false,
      automations: false,
    });
  });

  test("a compact sidebar shows only the first expanded panel in sidebar order", () => {
    expect(compactSidebarPanels(panels)).toEqual({
      teams: true,
      sessions: false,
      apps: false,
      automations: false,
    });
    expect(compactSidebarPanels({ ...panels, teams: false })).toMatchObject({ sessions: true });
    expect(
      compactSidebarPanels({ teams: false, sessions: false, apps: false, automations: false }),
    ).toEqual({ teams: false, sessions: false, apps: false, automations: false });
  });
});
