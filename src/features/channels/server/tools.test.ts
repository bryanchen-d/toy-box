import { expect, test } from "bun:test";
import { channelLeadTools, channelMemberTools, channelTools } from "./tools";

test.each([
  ["lead", channelLeadTools],
  ["member", channelMemberTools],
] as const)("%s channel protocol tools are available without discovery", (_role, tools) => {
  expect(
    tools
      .filter((tool) => tool.alwaysAvailable)
      .map((tool) => tool.name)
      .sort(),
  ).toEqual(["finish_agent_turn", "read_channel", "send_channel_message", "set_agent_status"]);
});

test("only leads receive nonterminal task and routine tools", () => {
  for (const name of ["update_channel", "edit_channel_tasks", "set_routine", "delete_routine"]) {
    const tool = channelLeadTools.find((tool) => tool.name === name);
    expect(tool).toBeDefined();
    expect(tool?.isTerminal).not.toBe(true);
    expect([...channelMemberTools, ...channelTools].some((tool) => tool.name === name)).toBe(false);
  }
});

test("the lead can select or clear a canvas using its shared artifact identity", () => {
  const update = channelLeadTools.find(({ name }) => name === "update_channel");
  for (const canvasArtifactId of ["session:lead:board.toy", null]) {
    expect(update?.parameters?.parse({ canvasArtifactId })).toEqual({ canvasArtifactId });
  }
  expect(update?.parameters?.safeParse({ canvasArtifactId: "" }).success).toBe(false);
});

test("only the lead's messages can request input", () => {
  const sendLead = channelLeadTools.find(({ name }) => name === "send_channel_message");
  const sendMember = channelMemberTools.find(({ name }) => name === "send_channel_message");
  const flagged = { content: "Which color?", request: true };

  expect<unknown>(sendLead?.parameters?.parse(flagged)).toEqual(flagged);
  expect<unknown>(sendMember?.parameters?.parse(flagged)).toEqual({ content: "Which color?" });
});

test("only the lead can ask to be woken, and within two hours", () => {
  const finishLead = channelLeadTools.find(({ name }) => name === "finish_agent_turn");
  const finishMember = channelMemberTools.find(({ name }) => name === "finish_agent_turn");
  const followUp = { waitingFor: "CI to finish", wakeAfterMinutes: 20 };

  expect(finishLead?.parameters?.safeParse(followUp).success).toBe(true);
  expect(finishLead?.parameters?.safeParse({ ...followUp, wakeAfterMinutes: 121 }).success).toBe(
    false,
  );
  expect(finishMember?.parameters?.safeParse(followUp).success).toBe(false);
});
