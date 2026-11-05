/** The panels a Team pane opens beside chat from its panel bar, in bar order. */
export const TEAM_PANELS = [
  "overview",
  "canvas",
  "members",
  "tasks",
  "artifacts",
  "routines",
] as const;

export type TeamPanel = (typeof TEAM_PANELS)[number];

export function isTeamPanel(value: unknown): value is TeamPanel {
  return TEAM_PANELS.includes(value as TeamPanel);
}
