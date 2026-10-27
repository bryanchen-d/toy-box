import { describe, expect, test } from "bun:test";
import { machineFile } from "@files/model";
import type {
  ArrangeChannelArtifactsInput,
  ChannelAgent,
  ChannelArtifact,
  ChannelMember,
} from "./index";
import {
  agentHandleFromName,
  applyChannelArtifactArrangement,
  arrangeChannelArtifactsInputSchema,
  channelAudienceLabel,
  channelLead,
  channelRoutineInputSchema,
  channelSystemMessageContentSchema,
  channelUnreadAfter,
  editChannelInputSchema,
  markChannelReadInputSchema,
  postChannelMessageInputSchema,
  resolveChannelAudience,
  selfUpdateChannelMemberInputSchema,
  setChannelAgentStatusInputSchema,
  splitAgentMentionText,
  updateChannelInputSchema,
} from "./index";

const members: ChannelMember[] = [
  { channelId: "channel", id: "critic", name: "Critic" },
  { channelId: "channel", id: "builder", name: "Builder" },
];
const lead = channelLead("lead");

const user = { type: "user" } as const;
const critic = { type: "agent", agentId: "critic" } as const;
const leadSender = { type: "agent", agentId: lead.id } as const;

function audience(content: string, sender: typeof user | typeof critic | typeof leadSender = user) {
  return resolveChannelAudience({ content, sender, lead, members });
}

describe("channel delivery policy", () => {
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
  test.each<{ acknowledgedRequest: boolean; expected: ChannelAgent[] }>([
    { acknowledgedRequest: true, expected: [lead, members[1]!] },
    { acknowledgedRequest: false, expected: [members[1]!] },
  ])(
    "request acknowledgement wakes the lead alongside mentions ($acknowledgedRequest)",
    ({ acknowledgedRequest, expected }) => {
      expect(
        resolveChannelAudience({
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

describe("channel unread position", () => {
  test("unread messages follow the read position while anything does", () => {
    expect(channelUnreadAfter({ seenThrough: 4, latestSequence: 7 })).toBe(4);
    expect(channelUnreadAfter({ seenThrough: 0, latestSequence: 2 })).toBe(0);
  });

  test("a fully read channel has no unread position", () => {
    expect(channelUnreadAfter({ seenThrough: 7, latestSequence: 7 })).toBeNull();
  });
});

describe("channel audience labels", () => {
  test("names each agent a message reaches", () => {
    expect(channelAudienceLabel([members[0]!, members[1]!], 3)).toBe("Critic, Builder");
  });

  test("reaching every agent the sender could reads as Everyone", () => {
    expect(channelAudienceLabel([lead, members[0]!, members[1]!], 3)).toBe("Everyone");
    expect(channelAudienceLabel([members[0]!, members[1]!], 2)).toBe("Everyone");
  });

  test("a lone recipient is named, even when it's the only one reachable", () => {
    expect(channelAudienceLabel([lead], 1)).toBe("Lead");
  });
});

describe("channel agent mentions", () => {
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
      selfUpdateChannelMemberInputSchema.safeParse({
        avatar: { mark: "M5 12h14M12 5v14", color: "#7c3aed" },
      }).success,
    ).toBe(true);
    expect(
      selfUpdateChannelMemberInputSchema.safeParse({
        avatar: { mark: "<path />", color: "#7c3aed" },
      }).success,
    ).toBe(false);
  });
});

test("a working status points to at most one assigned message", () => {
  expect(
    setChannelAgentStatusInputSchema.safeParse({
      status: "Reviewing and implementing",
      lookingAt: 1,
      workingOn: 1,
    }).success,
  ).toBe(false);
});

test("channel previews accept validated URL or screen targets", () => {
  expect(
    updateChannelInputSchema.safeParse({ preview: { kind: "url", url: "http://127.0.0.1:3000" } })
      .success,
  ).toBe(true);
  expect(
    updateChannelInputSchema.safeParse({ preview: { kind: "url", url: "/?files=%5B%5D" } }).success,
  ).toBe(true);
  expect(
    updateChannelInputSchema.safeParse({ preview: { kind: "url", url: "javascript:alert(1)" } })
      .success,
  ).toBe(false);
  expect(
    updateChannelInputSchema.safeParse({ preview: { kind: "url", url: "//example.com" } }).success,
  ).toBe(false);
  for (const url of ["/preview", "https://example.com", null]) {
    expect(
      channelSystemMessageContentSchema.safeParse({
        type: "preview_changed",
        actor: user,
        preview: url ? { kind: "url", url } : null,
      }).success,
    ).toBe(true);
  }
  expect(
    channelSystemMessageContentSchema.safeParse({
      type: "preview_changed",
      actor: user,
      preview: { kind: "url", url: "javascript:alert(1)" },
    }).success,
  ).toBe(false);
  expect(
    updateChannelInputSchema.safeParse({ preview: { kind: "screen", screenId: "screen" } }).success,
  ).toBe(true);
  expect(
    updateChannelInputSchema.safeParse({ preview: { kind: "screen", screenId: "" } }).success,
  ).toBe(false);
  expect(
    updateChannelInputSchema.safeParse({
      preview: { kind: "screen", screenId: "screen", url: "/preview" },
    }).success,
  ).toBe(false);
});

test("lead edits allow clearing optional fields and require a change", () => {
  expect(updateChannelInputSchema.safeParse({ purpose: null, directory: null }).success).toBe(true);
  expect(updateChannelInputSchema.safeParse({}).success).toBe(false);
});

test("user messages require content or attachments and exclude agent-controlled fields", () => {
  const message = { id: "message", channelId: "channel", content: "Hello" };
  expect(postChannelMessageInputSchema.safeParse(message).success).toBe(true);
  expect(
    postChannelMessageInputSchema.safeParse({
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
    expect(postChannelMessageInputSchema.safeParse({ ...message, ...change }).success).toBe(false);
  }
});

test("read positions are nonnegative integer sequences", () => {
  for (const sequence of [0, 1]) {
    expect(markChannelReadInputSchema.safeParse({ channelId: "channel", sequence }).success).toBe(
      true,
    );
  }
  for (const sequence of [-1, 1.5]) {
    expect(markChannelReadInputSchema.safeParse({ channelId: "channel", sequence }).success).toBe(
      false,
    );
  }
});

test("property events carry exactly the value their field allows", () => {
  const actor = { type: "user" };
  expect(
    channelSystemMessageContentSchema.safeParse({
      type: "channel_purpose_changed",
      actor,
      purpose: null,
    }).success,
  ).toBe(true);
  expect(
    channelSystemMessageContentSchema.safeParse({ type: "channel_renamed", actor, name: null })
      .success,
  ).toBe(false);
  expect(
    channelSystemMessageContentSchema.safeParse({
      type: "channel_renamed",
      actor,
      name: "Plan",
      purpose: "Extra",
    }).success,
  ).toBe(false);
});

test("channel edits change only allowed properties", () => {
  expect(
    editChannelInputSchema.safeParse({
      channelId: "channel",
      name: "Planning",
      purpose: null,
      model: { provider: "copilot", name: "gpt-5.5" },
    }).success,
  ).toBe(true);
  expect(editChannelInputSchema.safeParse({ channelId: "channel" }).success).toBe(false);
  expect(
    editChannelInputSchema.safeParse({
      channelId: "channel",
      directory: "/different-project",
    }).success,
  ).toBe(false);
});

describe("channel routines", () => {
  test.each(["0 9 * * 1-5", "30 */2 * * *", "0 * * * *", "15 8 1 * *"])(
    "accepts %s because one fixed minute runs at most hourly",
    (schedule) => {
      expect(
        channelRoutineInputSchema.safeParse({ title: "CI", schedule, prompt: "Check CI" }).success,
      ).toBe(true);
    },
  );

  test.each(["*/15 * * * *", "0,30 9 * * *", "0-5 9 * * *", "@hourly", "0 0 9 * * *"])(
    "rejects %s",
    (schedule) => {
      expect(
        channelRoutineInputSchema.safeParse({ title: "CI", schedule, prompt: "Check CI" }).success,
      ).toBe(false);
    },
  );
});

describe("artifact arrangement", () => {
  const artifact = (name: string): ChannelArtifact => {
    const file = machineFile(`/workspace/${name}.md`);
    return { id: `machine:${file.path}`, file, title: name, sharedAt: "2026-10-27T16:00:00.000Z" };
  };
  const [plan, spec, notes, brief] = ["plan", "spec", "notes", "brief"].map(artifact) as [
    ChannelArtifact,
    ChannelArtifact,
    ChannelArtifact,
    ChannelArtifact,
  ];
  const artifacts = [plan, spec, notes, brief];
  const arrange = (
    artifactIds: ChannelArtifact[],
    arrangement: { beforeArtifactId?: ChannelArtifact | null; archived?: boolean } = {},
  ) =>
    applyChannelArtifactArrangement(artifacts, {
      artifactIds: artifactIds.map(({ id }) => id),
      ...(arrangement.beforeArtifactId !== undefined
        ? { beforeArtifactId: arrangement.beforeArtifactId?.id ?? null }
        : {}),
      ...(arrangement.archived !== undefined ? { archived: arrangement.archived } : {}),
    });
  const titles = (arranged: readonly ChannelArtifact[]) => arranged.map(({ title }) => title);

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
    const restored = applyChannelArtifactArrangement(archived, {
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

  test.each<Omit<ArrangeChannelArtifactsInput, "channelId">>([
    { artifactIds: ["machine:/workspace/missing.md"] },
    { artifactIds: [plan.id], beforeArtifactId: "machine:/workspace/missing.md" },
  ])("rejects artifacts this channel hasn't shared: %o", (arrangement) => {
    expect(() => applyChannelArtifactArrangement(artifacts, arrangement)).toThrow(
      "Arrange artifacts shared in this channel.",
    );
  });

  test("rejects moving artifacts before one of themselves", () => {
    expect(() => arrange([plan, spec], { beforeArtifactId: spec })).toThrow(
      "Move artifacts before one that isn't moving.",
    );
  });

  test("lists each artifact at most once", () => {
    const input = { channelId: "channel", artifactIds: [plan.id, plan.id] };
    expect(arrangeChannelArtifactsInputSchema.safeParse(input).success).toBe(false);
    expect(
      arrangeChannelArtifactsInputSchema.safeParse({ ...input, artifactIds: [] }).success,
    ).toBe(false);
  });
});
