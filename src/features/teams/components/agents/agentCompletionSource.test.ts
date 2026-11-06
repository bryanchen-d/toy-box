import { describe, expect, test } from "bun:test";
import { teamLead, type TeamMember } from "@teams/model";
import { matchCompletion } from "@/shared/composers/completions/useCompletions";
import { agentCompletionSource } from "./agentCompletionSource";

const lead = teamLead("lead");
const members: TeamMember[] = [
  { teamId: "team", id: "critic", name: "Critic" },
  { teamId: "team", id: "builder", name: "Builder" },
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
  test("a paused team can still mention existing agents without offering new ones", () => {
    const source = agentCompletionSource({ lead, members });
    expect(source.query("critic")).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "@critic" })]),
    );
    expect(source.query("new-agent")).toEqual([]);
  });

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
      ["@everyone", "Team"],
      ["@lead", "Team"],
      ["@builder", "In this team"],
      ["@critic", "In this team"],
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

  test("offers connectors after the team, and never offers to create a member by their handle", () => {
    const source = agentCompletionSource({
      lead,
      members,
      connectors: [{ name: "BryanBot" }],
      createMember: () => new Promise(() => {}),
    });
    expect(source.query("bryanbot")).toEqual([
      expect.objectContaining({ value: "@bryanbot", label: "BryanBot", group: "Connectors" }),
    ]);
  });
});
