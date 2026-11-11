import { afterEach, expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { agentTeamsDirectory, copilotDirectory } from "./storage";

const original = {
  AGENT_TEAMS_HOME: process.env.AGENT_TEAMS_HOME,
  COPILOT_HOME: process.env.COPILOT_HOME,
};

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

for (const [variable, defaultName, directory] of [
  ["AGENT_TEAMS_HOME", ".agent-teams", agentTeamsDirectory],
  ["COPILOT_HOME", ".copilot", copilotDirectory],
] as const) {
  test(`${variable} relocates storage without changing relative resource paths`, () => {
    delete process.env[variable];
    expect(directory("sessions", "example")).toBe(
      join(homedir(), defaultName, "sessions", "example"),
    );
    const root = join(tmpdir(), "relocated-agent-data");
    process.env[variable] = root;
    expect(directory("sessions", "example")).toBe(join(root, "sessions", "example"));
  });

  test(`${variable} rejects empty and relative overrides`, () => {
    for (const value of ["", "relative-data"]) {
      process.env[variable] = value;
      expect(() => directory()).toThrow(`${variable} must be an absolute directory path.`);
    }
  });
}
