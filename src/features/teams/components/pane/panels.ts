import type { TeamAdvice } from "@teams/model/advice";
import type { Hotkey } from "@tanstack/react-hotkeys";

/** The panels a Team pane opens beside chat from its panel bar, in bar order. */
export const TEAM_PANELS = [
  "overview",
  "canvas",
  "members",
  "tasks",
  "artifacts",
  "routines",
  "performance",
  "security",
] as const;

export type TeamPanel = (typeof TEAM_PANELS)[number];

export const TEAM_PANEL_SHORTCUTS = {
  overview: "Mod+Shift+O",
  canvas: "Mod+Shift+C",
  members: "Mod+Shift+M",
  tasks: "Mod+Shift+T",
  artifacts: "Mod+Shift+A",
  routines: "Mod+Shift+R",
  performance: "Mod+Shift+P",
  security: "Mod+Shift+S",
} as const satisfies Record<TeamPanel, Hotkey>;

export function isTeamPanel(value: unknown): value is TeamPanel {
  return TEAM_PANELS.includes(value as TeamPanel);
}

export function teamPanelAlerts(
  advice: readonly TeamAdvice[],
  securityAlert: boolean,
): Set<TeamPanel> {
  const alerts = new Set<TeamPanel>();
  if (advice.some(({ status }) => status === "open")) alerts.add("performance");
  if (securityAlert) alerts.add("security");
  return alerts;
}
