import { describe, expect, test } from "bun:test";
import { channelLead, type ChannelMember } from "@channels/model";
import { matchCompletion } from "@/shared/composers/completions/useCompletions";
import { agentCompletionSource } from "./agentCompletionSource";

const lead = channelLead("lead");
const members: ChannelMember[] = [
  { channelId: "channel", id: "critic", name: "Critic" },
  { channelId: "channel", id: "builder", name: "Builder" },
];

function complete(
  query: string,
  createMember: (name: string) => Promise<{ name: string }> = () => new Promise(() => {}),
) {
  const source = agentCompletionSource({ lead, members, createMember });
  const items = source.query(query);
  if (!Array.isArray(items)) throw new Error("Agent items must be immediate.");
  return { source, items };
}

describe("agentCompletionSource", () => {
  test("matches agent handles at mention boundaries", () => {
    const { trigger } = complete("").source;
    expect(matchCompletion(trigger, "Ask (@Res", 9)).toEqual({
      start: 5,
      end: 9,
      query: "Res",
    });
    expect(matchCompletion(trigger, "mail dev@example", 16)).toBeUndefined();
    expect(matchCompletion(trigger, "Ask @critic next", 8)).toEqual({
      start: 4,
      end: 11,
      query: "cri",
    });
  });

  test("offers everyone, the lead, then members by name, inserting their handles", () => {
    const { source, items } = complete("");
    expect(items.map(({ value, group }) => [value, group])).toEqual([
      ["@everyone", "Channel"],
      ["@lead", "Channel"],
      ["@builder", "In this channel"],
      ["@critic", "In this channel"],
    ]);
    expect(source.accept!(items[2]!)).toBe("@builder");
    expect(complete("CRIT").items.map(({ value }) => value)).toEqual(["@critic", "@crit"]);
  });

  test("an unknown handle offers to create that member and inserts its created mention", async () => {
    expect(complete("critic").items.some(({ kind }) => kind === "create")).toBe(false);
    let created = "";
    const { source, items } = complete("NEW-agent", async (name) => {
      created = name;
      return { name: "New Agent 2" };
    });
    const create = items.find(({ kind }) => kind === "create")!;
    expect(create).toMatchObject({ value: "@new-agent", label: "New Agent", group: "New member" });
    expect(await source.accept!(create)).toBe("@new-agent-2");
    expect(created).toBe("New Agent");
  });
});
