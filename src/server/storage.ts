import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export function agentTeamsDirectory(...paths: string[]): string {
  return join(storageRoot("AGENT_TEAMS_HOME", ".agent-teams"), ...paths);
}

export function copilotDirectory(...paths: string[]): string {
  return join(storageRoot("COPILOT_HOME", ".copilot"), ...paths);
}

function storageRoot(variable: string, defaultName: string): string {
  const configured = process.env[variable];
  if (configured !== undefined) {
    if (!isAbsolute(configured)) throw new Error(`${variable} must be an absolute directory path.`);
    return configured;
  }
  return join(homedir().trim() || process.cwd(), defaultName);
}
