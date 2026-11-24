import { expect, test } from "bun:test";
import { teamLeadTools, teamMemberTools, teamTools } from "./tools";

test.each([
  ["lead", teamLeadTools],
  ["member", teamMemberTools],
  ["session", teamTools],
] as const)("%s tools can inspect references", (_role, tools) => {
  for (const name of ["list_teams", "inspect_team", "read_team"])
    expect(tools.some((tool) => tool.name === name)).toBe(true);
  expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  const inspect = tools.find(({ name }) => name === "inspect_team")!;
  expect(inspect.parameters?.safeParse({ uri: "team:source/messages/42" }).success).toBe(true);
  expect(inspect.parameters?.safeParse({ uri: "team:source", beforeSequence: 10 }).success).toBe(
    true,
  );
  expect(
    inspect.parameters?.safeParse({ uri: "team:source/messages/42", beforeSequence: 10 }).success,
  ).toBe(false);
  expect(
    inspect.parameters?.safeParse({ uri: "team:source", beforeSequence: 10, threadSequence: 1 })
      .success,
  ).toBe(false);
  expect(inspect.parameters?.safeParse({ uri: "team:source/members/other" }).success).toBe(false);
});

test.each([
  ["lead", teamLeadTools],
  ["member", teamMemberTools],
] as const)("%s team protocol tools are available without discovery", (_role, tools) => {
  expect(
    tools
      .filter((tool) => tool.alwaysAvailable)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(["finish_agent_turn", "read_team", "send_team_message", "set_agent_status"]);
});

test("only leads receive nonterminal team and routine tools; assignees edit their own tasks", () => {
  for (const name of ["update_team", "set_routine", "delete_routine"]) {
    const tool = teamLeadTools.find((tool) => tool.name === name);
    expect(tool).toBeDefined();
    expect(tool?.isTerminal).not.toBe(true);
    expect([...teamMemberTools, ...teamTools].some((tool) => tool.name === name)).toBe(false);
  }
  for (const tools of [teamLeadTools, teamMemberTools]) {
    expect(tools.some(({ name }) => name === "edit_team_tasks")).toBe(true);
  }
  expect(teamTools.some(({ name }) => name === "edit_team_tasks")).toBe(false);
});

test("the lead can select or clear a canvas using its shared artifact identity", () => {
  const update = teamLeadTools.find(({ name }) => name === "update_team");
  for (const canvasArtifactId of ["session:lead:board.toy", null]) {
    expect(update?.parameters?.parse({ canvasArtifactId })).toEqual({ canvasArtifactId });
  }
  expect(update?.parameters?.safeParse({ canvasArtifactId: "" }).success).toBe(false);
});

test("team icons use the same constrained vector format as member avatars", () => {
  const update = teamLeadTools.find(({ name }) => name === "update_team");
  const avatar = { mark: "M5 12h14M12 5v14", color: "#7c3aed" };
  expect(update?.parameters?.parse({ avatar })).toEqual({ avatar });
  expect(update?.parameters?.parse({ avatar: null })).toEqual({ avatar: null });
  for (const invalid of [
    { ...avatar, mark: "<svg onload='alert(1)'/>" },
    { ...avatar, color: "url(https://example.com/image)" },
    { ...avatar, mark: "" },
    { ...avatar, color: "#fff" },
    { ...avatar, url: "https://example.com/image" },
  ]) {
    expect(update?.parameters?.safeParse({ avatar: invalid }).success).toBe(false);
  }
});

test("only the lead's messages can request input or interrupt", () => {
  const sendLead = teamLeadTools.find(({ name }) => name === "send_team_message");
  const sendMember = teamMemberTools.find(({ name }) => name === "send_team_message");
  const flagged = { content: "Which color?", request: true, interrupt: true };

  expect<unknown>(sendLead?.parameters?.parse(flagged)).toEqual(flagged);
  expect<unknown>(sendMember?.parameters?.parse(flagged)).toEqual({ content: "Which color?" });
});

test("only the lead can ask to be woken, and within two hours", () => {
  const finishLead = teamLeadTools.find(({ name }) => name === "finish_agent_turn");
  const finishMember = teamMemberTools.find(({ name }) => name === "finish_agent_turn");
  const followUp = { waitingFor: "CI to finish", wakeAfterMinutes: 20 };

  expect(finishLead?.parameters?.safeParse(followUp).success).toBe(true);
  expect(finishLead?.parameters?.safeParse({ ...followUp, wakeAfterMinutes: 121 }).success).toBe(
    false,
  );
  expect(finishMember?.parameters?.safeParse(followUp).success).toBe(false);
});
