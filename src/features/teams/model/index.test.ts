import { describe, expect, test } from "bun:test";
import { machineFile } from "@files/model";
import type { ArrangeTeamArtifactsInput, TeamAgent, TeamArtifact, TeamMember } from "./index";
import {
  agentHandleFromName,
  applyTeamArtifactArrangement,
  arrangeTeamArtifactsInputSchema,
  teamAudienceLabel,
  teamLead,
  teamRoutineInputSchema,
  teamSystemMessageContentSchema,
  teamUnreadAfter,
  editTeamInputSchema,
  markTeamReadInputSchema,
  postTeamMessageInputSchema,
  resolveTeamAudience,
  selfUpdateTeamMemberInputSchema,
  setTeamAgentStatusInputSchema,
  splitAgentMentionText,
  updateTeamInputSchema,
} from "./index";

const members: TeamMember[] = [
  { teamId: "team", id: "critic", name: "Critic" },
  { teamId: "team", id: "builder", name: "Builder" },
];
const lead = teamLead("lead");

const user = { type: "user" } as const;
const critic = { type: "agent", agentId: "critic" } as const;
const leadSender = { type: "agent", agentId: lead.id } as const;

test("only user edits can pause or resume a team", () => {
  for (const paused of [true, false]) {
    expect(editTeamInputSchema.parse({ teamId: "team", paused })).toEqual({
      teamId: "team",
      paused,
    });
    expect(updateTeamInputSchema.safeParse({ paused }).success).toBe(false);
  }
});

function audience(content: string, sender: typeof user | typeof critic | typeof leadSender = user) {
  return resolveTeamAudience({ content, sender, lead, members });
}

describe("team delivery policy", () => {
  test("unmentioned messages route to the intrinsic lead", () => {
    expect(audience("Please review")).toEqual([lead]);
    expect(audience("Here is my review", critic)).toEqual([lead]);
    expect(audience("Here is the plan", leadSender)).toEqual([]);
  });

  test("mentions route to exact agents without waking the sender", () => {
    expect(audience("@critic Please review")).toEqual([members[0]]);
    expect(audience("@lead Please review")).toEqual([lead]);
    expect(audience("@everyone Please review")).toEqual([lead, ...members]);
    expect(audience("@critci Please review")).toEqual([]);
    expect(audience("@critic @builder please check", critic)).toEqual([members[1]]);
    expect(audience("@everyone please check", critic)).toEqual([lead, members[1]]);
    expect(audience("@builder @builder", critic)).toEqual([members[1]]);
  });

  test("a handle that names no agent addresses only where the message opens", () => {
    // Addressing only a connector wakes nobody in the team.
    expect(audience("@bryanbot post this to #dev")).toEqual([]);
    expect(audience("@lead @bryanbot post this")).toEqual([lead]);
    // Talking about one is just text, so the message routes as if it had no mentions.
    expect(audience("Can you ask @bryanbot to DM me?")).toEqual([lead]);
    expect(audience("That went through @bryanbot", critic)).toEqual([lead]);
    expect(audience("Posted through @bryanbot", leadSender)).toEqual([]);
    expect(audience("Thanks, and @critic please check the post from @bryanbot")).toEqual([
      members[0],
    ]);
  });
  test.each<{ acknowledgedRequest: boolean; expected: TeamAgent[] }>([
    { acknowledgedRequest: true, expected: [lead, members[1]!] },
    { acknowledgedRequest: false, expected: [members[1]!] },
  ])(
    "request acknowledgement wakes the lead alongside mentions ($acknowledgedRequest)",
    ({ acknowledgedRequest, expected }) => {
      expect(
        resolveTeamAudience({
          content: "@builder use blue",
          sender: user,
          lead,
          members,
          acknowledgedRequest,
        }),
      ).toEqual(expected);
    },
  );
});

describe("team unread position", () => {
  test("unread messages follow the read position while anything does", () => {
    expect(teamUnreadAfter({ seenThrough: 4, latestSequence: 7 })).toBe(4);
    expect(teamUnreadAfter({ seenThrough: 0, latestSequence: 2 })).toBe(0);
  });

  test("a fully read team has no unread position", () => {
    expect(teamUnreadAfter({ seenThrough: 7, latestSequence: 7 })).toBeNull();
  });
});

describe("team audience labels", () => {
  test("names each agent a message reaches", () => {
    expect(teamAudienceLabel([members[0]!, members[1]!], 3)).toBe("Critic, Builder");
  });

  test("reaching every agent the sender could reads as Everyone", () => {
    expect(teamAudienceLabel([lead, members[0]!, members[1]!], 3)).toBe("Everyone");
    expect(teamAudienceLabel([members[0]!, members[1]!], 2)).toBe("Everyone");
  });

  test("a lone recipient is named, even when it's the only one reachable", () => {
    expect(teamAudienceLabel([lead], 1)).toBe("Lead");
  });
});

describe("team agent mentions", () => {
  test("derives safe handles", () => {
    expect(agentHandleFromName("Design Critic")).toBe("design-critic");
    expect(agentHandleFromName("Everyone")).toBe("everyone-agent");
  });

  test("splits visible mentions without treating email addresses as mentions", () => {
    expect(splitAgentMentionText("Ask @Critic, then dev@example.com.")).toEqual([
      { type: "text", content: "Ask " },
      { type: "mention", content: "@Critic", handle: "critic" },
      { type: "text", content: ", then dev@example.com." },
    ]);
  });

  test("accepts SVG path data for avatars but rejects markup", () => {
    expect(
      selfUpdateTeamMemberInputSchema.safeParse({
        avatar: { mark: "M5 12h14M12 5v14", color: "#7c3aed" },
      }).success,
    ).toBe(true);
    expect(
      selfUpdateTeamMemberInputSchema.safeParse({
        avatar: { mark: "<path />", color: "#7c3aed" },
      }).success,
    ).toBe(false);
  });
});

test("a working status points to at most one assigned message", () => {
  expect(
    setTeamAgentStatusInputSchema.safeParse({
      status: "Reviewing and implementing",
      lookingAt: 1,
      workingOn: 1,
    }).success,
  ).toBe(false);
});

test("team previews accept validated URL or screen targets", () => {
  expect(
    updateTeamInputSchema.safeParse({ preview: { kind: "url", url: "http://127.0.0.1:3000" } })
      .success,
  ).toBe(true);
  expect(
    updateTeamInputSchema.safeParse({ preview: { kind: "url", url: "/?files=%5B%5D" } }).success,
  ).toBe(true);
  expect(
    updateTeamInputSchema.safeParse({ preview: { kind: "url", url: "javascript:alert(1)" } })
      .success,
  ).toBe(false);
  expect(
    updateTeamInputSchema.safeParse({ preview: { kind: "url", url: "//example.com" } }).success,
  ).toBe(false);
  for (const url of ["/preview", "https://example.com", null]) {
    expect(
      teamSystemMessageContentSchema.safeParse({
        type: "preview_changed",
        actor: user,
        preview: url ? { kind: "url", url } : null,
      }).success,
    ).toBe(true);
  }
  expect(
    teamSystemMessageContentSchema.safeParse({
      type: "preview_changed",
      actor: user,
      preview: { kind: "url", url: "javascript:alert(1)" },
    }).success,
  ).toBe(false);
  expect(
    updateTeamInputSchema.safeParse({ preview: { kind: "screen", screenId: "screen" } }).success,
  ).toBe(true);
  expect(
    updateTeamInputSchema.safeParse({ preview: { kind: "screen", screenId: "" } }).success,
  ).toBe(false);
  expect(
    updateTeamInputSchema.safeParse({
      preview: { kind: "screen", screenId: "screen", url: "/preview" },
    }).success,
  ).toBe(false);
});

test("lead edits allow clearing optional fields and require a change", () => {
  expect(updateTeamInputSchema.safeParse({ purpose: null, directory: null }).success).toBe(true);
  expect(updateTeamInputSchema.safeParse({}).success).toBe(false);
});

test("user messages require content or attachments and exclude agent-controlled fields", () => {
  const message = { id: "message", teamId: "team", content: "Hello" };
  expect(postTeamMessageInputSchema.safeParse(message).success).toBe(true);
  expect(
    postTeamMessageInputSchema.safeParse({
      ...message,
      content: "",
      attachments: [{ mimeType: "image/png", base64: "AAEC" }],
    }).success,
  ).toBe(true);
  for (const change of [
    { content: "" },
    { content: "A".repeat(12_001) },
    { sender: { type: "agent", agentId: "lead" } },
  ]) {
    expect(postTeamMessageInputSchema.safeParse({ ...message, ...change }).success).toBe(false);
  }
});

test("read positions are nonnegative integer sequences", () => {
  for (const sequence of [0, 1]) {
    expect(markTeamReadInputSchema.safeParse({ teamId: "team", sequence }).success).toBe(true);
  }
  for (const sequence of [-1, 1.5]) {
    expect(markTeamReadInputSchema.safeParse({ teamId: "team", sequence }).success).toBe(false);
  }
});

test("property events carry exactly the value their field allows", () => {
  const actor = { type: "user" };
  expect(
    teamSystemMessageContentSchema.safeParse({
      type: "team_purpose_changed",
      actor,
      purpose: null,
    }).success,
  ).toBe(true);
  expect(
    teamSystemMessageContentSchema.safeParse({ type: "team_renamed", actor, name: null }).success,
  ).toBe(false);
  expect(
    teamSystemMessageContentSchema.safeParse({
      type: "team_renamed",
      actor,
      name: "Plan",
      purpose: "Extra",
    }).success,
  ).toBe(false);
});

test("team edits change only allowed properties", () => {
  expect(
    editTeamInputSchema.safeParse({
      teamId: "team",
      name: "Planning",
      purpose: null,
      model: { provider: "copilot", name: "gpt-5.5" },
    }).success,
  ).toBe(true);
  expect(editTeamInputSchema.safeParse({ teamId: "team" }).success).toBe(false);
  expect(
    editTeamInputSchema.safeParse({
      teamId: "team",
      directory: "/different-project",
    }).success,
  ).toBe(false);
});

describe("team routines", () => {
  test.each(["0 9 * * 1-5", "30 */2 * * *", "0 * * * *", "15 8 1 * *"])(
    "accepts %s because one fixed minute runs at most hourly",
    (schedule) => {
      expect(
        teamRoutineInputSchema.safeParse({ title: "CI", schedule, prompt: "Check CI" }).success,
      ).toBe(true);
    },
  );

  test.each(["*/15 * * * *", "0,30 9 * * *", "0-5 9 * * *", "@hourly", "0 0 9 * * *"])(
    "rejects %s",
    (schedule) => {
      expect(
        teamRoutineInputSchema.safeParse({ title: "CI", schedule, prompt: "Check CI" }).success,
      ).toBe(false);
    },
  );
});

describe("artifact arrangement", () => {
  const artifact = (name: string): TeamArtifact => {
    const file = machineFile(`/workspace/${name}.md`);
    return { id: `machine:${file.path}`, file, title: name, sharedAt: "2026-10-27T16:00:00.000Z" };
  };
  const [plan, spec, notes, brief] = ["plan", "spec", "notes", "brief"].map(artifact) as [
    TeamArtifact,
    TeamArtifact,
    TeamArtifact,
    TeamArtifact,
  ];
  const artifacts = [plan, spec, notes, brief];
  const arrange = (
    artifactIds: TeamArtifact[],
    arrangement: { beforeArtifactId?: TeamArtifact | null; archived?: boolean } = {},
  ) =>
    applyTeamArtifactArrangement(artifacts, {
      artifactIds: artifactIds.map(({ id }) => id),
      ...(arrangement.beforeArtifactId !== undefined
        ? { beforeArtifactId: arrangement.beforeArtifactId?.id ?? null }
        : {}),
      ...(arrangement.archived !== undefined ? { archived: arrangement.archived } : {}),
    });
  const titles = (arranged: readonly TeamArtifact[]) => arranged.map(({ title }) => title);

  test("pins stay first through moves, and new pins follow existing pins", () => {
    const pinned = applyTeamArtifactArrangement(artifacts, {
      artifactIds: [notes.id],
      pinned: true,
    });
    const both = applyTeamArtifactArrangement(pinned, { artifactIds: [plan.id], pinned: true });
    expect(titles(both)).toEqual(["notes", "plan", "spec", "brief"]);
    expect(both.slice(0, 2).every(({ pinned }) => pinned)).toBe(true);
    const moved = applyTeamArtifactArrangement(both, {
      artifactIds: [brief.id],
      beforeArtifactId: notes.id,
    });
    expect(titles(moved)).toEqual(["notes", "plan", "brief", "spec"]);
    const archived = applyTeamArtifactArrangement(both, {
      artifactIds: [notes.id],
      archived: true,
    });
    expect(archived.find(({ id }) => id === notes.id)).toMatchObject({ archived: true });
    expect(archived.find(({ id }) => id === notes.id)).not.toHaveProperty("pinned");
    expect(titles(archived)).toEqual(["plan", "notes", "spec", "brief"]);
    expect(() =>
      applyTeamArtifactArrangement(archived, { artifactIds: [notes.id], pinned: true }),
    ).toThrow("Restore an artifact");
    const restored = applyTeamArtifactArrangement(archived, {
      artifactIds: [notes.id],
      archived: false,
    });
    expect(restored.find(({ id }) => id === notes.id)).not.toHaveProperty("pinned");
  });

  test("moves an artifact before another, or last for null", () => {
    expect(titles(arrange([notes], { beforeArtifactId: plan }))).toEqual([
      "notes",
      "plan",
      "spec",
      "brief",
    ]);
    expect(titles(arrange([plan], { beforeArtifactId: notes }))).toEqual([
      "spec",
      "plan",
      "notes",
      "brief",
    ]);
    expect(titles(arrange([plan], { beforeArtifactId: null }))).toEqual([
      "spec",
      "notes",
      "brief",
      "plan",
    ]);
  });

  test("moves several artifacts together in the given order", () => {
    expect(titles(arrange([brief, spec], { beforeArtifactId: plan }))).toEqual([
      "brief",
      "spec",
      "plan",
      "notes",
    ]);
    // Sorting is moving every artifact in its sorted order.
    expect(titles(arrange([brief, notes, plan, spec], { beforeArtifactId: null }))).toEqual([
      "brief",
      "notes",
      "plan",
      "spec",
    ]);
  });

  test("archives and restores in place without touching other artifacts", () => {
    const archived = arrange([spec, brief], { archived: true });
    expect(archived).toEqual([
      plan,
      { ...spec, archived: true },
      notes,
      { ...brief, archived: true },
    ]);
    expect(archived[0]).toBe(plan);
    const restored = applyTeamArtifactArrangement(archived, {
      artifactIds: [spec.id, brief.id],
      archived: false,
    });
    expect(restored).toEqual(artifacts);
    expect(restored[1]).not.toHaveProperty("archived");
  });

  test("moves and archives together", () => {
    expect(arrange([plan], { beforeArtifactId: null, archived: true })).toEqual([
      spec,
      notes,
      brief,
      { ...plan, archived: true },
    ]);
  });

  test("an arrangement that changes nothing keeps every artifact", () => {
    for (const arranged of [
      arrange([spec]),
      arrange([spec], { beforeArtifactId: notes, archived: false }),
      arrange([spec, notes], { beforeArtifactId: brief }),
    ]) {
      expect(arranged).toEqual(artifacts);
      arranged.forEach((current, index) => expect(current).toBe(artifacts[index]!));
    }
  });

  test.each<Omit<ArrangeTeamArtifactsInput, "teamId">>([
    { artifactIds: ["machine:/workspace/missing.md"] },
    { artifactIds: [plan.id], beforeArtifactId: "machine:/workspace/missing.md" },
  ])("rejects artifacts this team hasn't shared: %o", (arrangement) => {
    expect(() => applyTeamArtifactArrangement(artifacts, arrangement)).toThrow(
      "Arrange artifacts shared in this team.",
    );
  });

  test("rejects moving artifacts before one of themselves", () => {
    expect(() => arrange([plan, spec], { beforeArtifactId: spec })).toThrow(
      "Move artifacts before one that isn't moving.",
    );
  });

  test("lists each artifact at most once", () => {
    const input = { teamId: "team", artifactIds: [plan.id, plan.id] };
    expect(arrangeTeamArtifactsInputSchema.safeParse(input).success).toBe(false);
    expect(arrangeTeamArtifactsInputSchema.safeParse({ ...input, artifactIds: [] }).success).toBe(
      false,
    );
  });
});
