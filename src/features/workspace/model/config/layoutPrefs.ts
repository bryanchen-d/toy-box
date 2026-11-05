import { z } from "zod";

// One sparse cookie lets SSR and the hydrated shell begin with the same
// browser-local workspace layout. Omitted values take their product defaults.

const LAYOUT_COOKIE = "agent_teams_layout";
const LAYOUT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const DEFAULT_SIDEBAR_WIDTH = 280;
const DEFAULT_TERMINAL_SIZE = 30;
const DEFAULT_HYPER_POSITION = { x: 24, y: 24 };

// The sidebar is sized in pixels so the workspace panes can keep dividing
// whatever is left as percentages, and so its width survives window resizes.
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

const TERMINAL_MIN_SIZE = 15;
const TERMINAL_MAX_SIZE = 80;

// A Team aside's share of a wide pane, as a percentage, so chat keeps a usable share too.
export const TEAM_ASIDE_MIN_SIZE = 25;
export const TEAM_ASIDE_MAX_SIZE = 75;

export function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

function clampTerminalSize(value: number): number {
  return Math.min(TERMINAL_MAX_SIZE, Math.max(TERMINAL_MIN_SIZE, value));
}

function clampTeamAsideSize(value: number): number {
  return Math.min(TEAM_ASIDE_MAX_SIZE, Math.max(TEAM_ASIDE_MIN_SIZE, value));
}

/** The sidebar's collapsible panels, in the order they stack. */
const SIDEBAR_PANELS = ["teams", "sessions", "apps", "automations"] as const;

export type SidebarPanel = (typeof SIDEBAR_PANELS)[number];

// Teams and Sessions lead the sidebar, so they start open; the rest start closed.
const DEFAULT_SIDEBAR_PANELS = { teams: true, sessions: true, apps: false, automations: false };

const sidebarPanelsSchema = z.object({
  teams: z.boolean().default(DEFAULT_SIDEBAR_PANELS.teams),
  sessions: z.boolean().default(DEFAULT_SIDEBAR_PANELS.sessions),
  apps: z.boolean().default(DEFAULT_SIDEBAR_PANELS.apps),
  automations: z.boolean().default(DEFAULT_SIDEBAR_PANELS.automations),
});

export type SidebarPanels = z.output<typeof sidebarPanelsSchema>;

/**
 * Desktop panels open independently. A compact sidebar has room for one, so
 * opening a panel there closes the rest.
 */
export function setSidebarPanelExpanded(
  panels: SidebarPanels,
  panel: SidebarPanel,
  expanded: boolean,
  compact: boolean,
): SidebarPanels {
  if (!compact) return { ...panels, [panel]: expanded };
  return sidebarPanelsWhere((other) => other === panel && expanded);
}

/** What a compact sidebar shows: only the first expanded panel, in sidebar order. */
export function compactSidebarPanels(panels: SidebarPanels): SidebarPanels {
  const open = SIDEBAR_PANELS.find((panel) => panels[panel]);
  return sidebarPanelsWhere((panel) => panel === open);
}

function sidebarPanelsWhere(isExpanded: (panel: SidebarPanel) => boolean): SidebarPanels {
  return {
    teams: isExpanded("teams"),
    sessions: isExpanded("sessions"),
    apps: isExpanded("apps"),
    automations: isExpanded("automations"),
  };
}

const workspaceLayoutSchema = z.object({
  sidebarWidth: z.number().finite().transform(clampSidebarWidth).default(DEFAULT_SIDEBAR_WIDTH),
  terminalSize: z.number().finite().transform(clampTerminalSize).default(DEFAULT_TERMINAL_SIZE),
  sidebarCollapsed: z.boolean().default(false),
  terminalOpen: z.boolean().default(false),
  panels: sidebarPanelsSchema.default(DEFAULT_SIDEBAR_PANELS),
  hyperOpen: z.boolean().default(false),
  hyperPosition: z
    .object({ x: z.number().finite(), y: z.number().finite() })
    .default(DEFAULT_HYPER_POSITION),
  teamOverviewPinned: z.boolean().default(false),
  /** Each Team aside kind's resized share of a wide pane; unresized kinds keep their default. */
  teamAsideSizes: z
    .record(z.string(), z.number().finite().transform(clampTeamAsideSize))
    .default({}),
});

export type WorkspaceLayout = z.output<typeof workspaceLayoutSchema>;

const DEFAULT_WORKSPACE_LAYOUT = workspaceLayoutSchema.parse({});

function readLayoutCookie(cookieHeader?: string | null): string | undefined {
  const prefix = `${LAYOUT_COOKIE}=`;
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

export function readWorkspaceLayout(cookieHeader?: string | null): WorkspaceLayout {
  const cookie = readLayoutCookie(cookieHeader);
  if (!cookie) return DEFAULT_WORKSPACE_LAYOUT;

  try {
    const parsed = workspaceLayoutSchema.safeParse(JSON.parse(decodeURIComponent(cookie)));
    return parsed.success ? parsed.data : DEFAULT_WORKSPACE_LAYOUT;
  } catch {
    return DEFAULT_WORKSPACE_LAYOUT;
  }
}

export function serializeWorkspaceLayout(layout: WorkspaceLayout): string {
  const changedPanels = SIDEBAR_PANELS.filter(
    (panel) => layout.panels[panel] !== DEFAULT_SIDEBAR_PANELS[panel],
  );
  const panels = Object.fromEntries(changedPanels.map((panel) => [panel, layout.panels[panel]]));

  const stored = {
    ...(layout.sidebarWidth !== DEFAULT_SIDEBAR_WIDTH ? { sidebarWidth: layout.sidebarWidth } : {}),
    ...(layout.terminalSize !== DEFAULT_TERMINAL_SIZE ? { terminalSize: layout.terminalSize } : {}),
    ...(layout.sidebarCollapsed ? { sidebarCollapsed: true } : {}),
    ...(layout.terminalOpen ? { terminalOpen: true } : {}),
    ...(changedPanels.length > 0 ? { panels } : {}),
    ...(layout.hyperOpen ? { hyperOpen: true } : {}),
    ...(layout.hyperPosition.x !== DEFAULT_HYPER_POSITION.x ||
    layout.hyperPosition.y !== DEFAULT_HYPER_POSITION.y
      ? { hyperPosition: layout.hyperPosition }
      : {}),
    ...(layout.teamOverviewPinned ? { teamOverviewPinned: true } : {}),
    ...(Object.keys(layout.teamAsideSizes).length > 0
      ? { teamAsideSizes: layout.teamAsideSizes }
      : {}),
  };

  return `${LAYOUT_COOKIE}=${encodeURIComponent(JSON.stringify(stored))}; Path=/; Max-Age=${LAYOUT_COOKIE_MAX_AGE}; SameSite=Lax`;
}
