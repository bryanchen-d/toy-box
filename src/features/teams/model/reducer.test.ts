import { expect, test } from "bun:test";
import { machineFile } from "@files/model";
import {
  teamLead,
  teamHasUnreadCompletion,
  type TeamConversationMessage,
  type TeamMessage,
  type TeamSystemMessageContent,
  type TeamState,
} from ".";
import { mergeTeamMessages, reduceTeamState } from "./reducer";

const message = (sequence: number): TeamConversationMessage => ({
  id: `message-${sequence}`,
  sequence,
  sender: { type: "user" },
  content: `Message ${sequence}`,
  timestamp: "2026-10-03T20:00:00.000Z",
});

function snapshot(): TeamState {
  return {
    team: {
      id: "team",
      name: "Studio",
      paused: false,
      model: { provider: "codex", name: "gpt-5.5" },
      tasks: [],
      latestSequence: 101,
      seenThrough: 0,
      requestSequence: null,
      completedSequence: null,
      updatedAt: "2026-10-03T20:00:00.000Z",
    },
    revision: 101,
    lead: teamLead("team"),
    members: [],
    messages: [message(1), message(101)],
    artifacts: [],
    routines: [],
    advice: [],
    request: null,
    presence: { team: { state: "idle" } },
  };
}

test("recovery snapshots replace stale older history", () => {
  const previous = snapshot();
  const current = {
    ...previous,
    revision: 103,
    messages: [message(101)],
  };
  expect(reduceTeamState(previous, { type: "snapshot", state: current })).toBe(current);
});

function system(sequence: number, content: TeamSystemMessageContent) {
  return {
    type: "message" as const,
    revision: sequence,
    message: {
      id: `system-${sequence}`,
      sequence,
      sender: { type: "system" as const },
      content,
      timestamp: "2026-10-03T21:00:00.000Z",
    },
  };
}

test("pause and resume replay to the same team state without changing attention", () => {
  const previous = snapshot();
  const paused = reduceTeamState(previous, system(102, { type: "team_paused", paused: true }));
  expect(paused.team.paused).toBe(true);
  expect(paused.team.requestSequence).toBe(previous.team.requestSequence);
  expect(paused.team.completedSequence).toBe(previous.team.completedSequence);
  expect(paused.revision).toBe(102);
  const resumed = reduceTeamState(paused, system(103, { type: "team_paused", paused: false }));
  expect(resumed.team.paused).toBe(false);
  expect(resumed.messages).toHaveLength(previous.messages.length + 2);
});

test("quiet tasks and model changes advance the cursor without creating transcript activity", () => {
  const previous = snapshot();
  previous.team.requestSequence = 100;
  previous.team.completedSequence = 101;
  const tasks = [
    {
      id: "build",
      title: "Build",
      status: "in_progress" as const,
      artifactId: "machine:/workspace/design.md",
      diff: { added: 12, removed: 3 },
    },
  ];
  const tasked = reduceTeamState(previous, { type: "tasks", revision: 102, tasks });
  expect(tasked.team).toEqual({ ...previous.team, tasks });
  expect(tasked.messages).toBe(previous.messages);
  const event = {
    type: "model" as const,
    revision: 103,
    model: { provider: "codex" as const, name: "gpt-5.5-mini" },
    updatedAt: "2026-10-03T21:00:00.000Z",
  };
  const changed = reduceTeamState(tasked, event);
  expect(changed.team).toEqual({
    ...tasked.team,
    model: event.model,
    updatedAt: event.updatedAt,
  });
  expect(changed.revision).toBe(103);
  expect(changed.messages).toBe(previous.messages);
  for (const revision of [event.revision, event.revision - 1]) {
    expect(reduceTeamState(changed, { ...event, revision })).toBe(changed);
  }
});

test("metadata messages update the public team alongside transcript activity", () => {
  const actor = { type: "user" as const };
  const events = [
    system(102, { type: "team_renamed", actor, name: "Release" }),
    system(103, { type: "team_purpose_changed", actor, purpose: "Ship it" }),
    system(104, { type: "team_directory_changed", actor, directory: "/work" }),
    system(105, { type: "preview_changed", actor, preview: { kind: "url", url: "/preview" } }),
    system(106, { type: "canvas_changed", actor, canvasArtifactId: "session:team:board.toy" }),
  ];
  const changed = events.reduce(reduceTeamState, snapshot());
  expect(changed.team).toMatchObject({
    name: "Release",
    purpose: "Ship it",
    directory: "/work",
    preview: { kind: "url", url: "/preview" },
    canvasArtifactId: "session:team:board.toy",
    latestSequence: 106,
    updatedAt: events[0]!.message.timestamp,
  });
  const cleared = [
    system(107, { type: "team_purpose_changed", actor, purpose: null }),
    system(108, { type: "team_directory_changed", actor, directory: null }),
    system(109, { type: "preview_changed", actor, preview: null }),
    system(110, { type: "canvas_changed", actor, canvasArtifactId: null }),
  ].reduce(reduceTeamState, changed);
  expect([cleared.team.purpose, cleared.team.directory, cleared.team.preview]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
  expect(cleared.team.canvasArtifactId).toBeUndefined();
  expect(cleared.messages.slice(-9).map(({ sequence }) => sequence)).toEqual([
    102, 103, 104, 105, 106, 107, 108, 109, 110,
  ]);
});

test("a pending request survives paging and reading, receives reactions, and clears on a later user reply", () => {
  const otherReaction = { agentId: "designer", reaction: "done" as const };
  const question = {
    ...message(102),
    sender: { type: "agent" as const, agentId: "team" },
    reactions: [otherReaction],
    request: true as const,
  };
  const previous = snapshot();
  previous.request = { ...question, id: "earlier-request", sequence: 1 };
  previous.team.requestSequence = 1;
  const requested = reduceTeamState(previous, {
    type: "message",
    revision: 102,
    message: question,
  });
  expect(requested.request).toBe(question);
  expect(requested.team.requestSequence).toBe(102);
  const completed = reduceTeamState(requested, system(104, { type: "tasks_completed" }));
  expect(completed.team.completedSequence).toBe(104);
  const partiallyRead = reduceTeamState(completed, {
    type: "read",
    revision: 105,
    seenThrough: 103,
  });
  expect(teamHasUnreadCompletion(partiallyRead.team)).toBe(true);
  const loadedReaction = reduceTeamState(partiallyRead, {
    type: "reaction",
    revision: 106,
    sequence: 102,
    agentId: "reviewer",
    reaction: "agree",
  });
  expect<TeamMessage | null | undefined>(loadedReaction.request).toEqual(
    loadedReaction.messages.find(({ sequence }) => sequence === question.sequence),
  );
  expect(loadedReaction.request?.reactions).toEqual([
    otherReaction,
    { agentId: "reviewer", reaction: "agree" },
  ]);
  const paged = {
    ...loadedReaction,
    team: { ...loadedReaction.team, latestSequence: 200 },
    messages: [message(200)],
    revision: 200,
  };
  const read = reduceTeamState(paged, {
    type: "read",
    revision: 201,
    seenThrough: 200,
  });
  expect(read.team).toMatchObject({
    seenThrough: 200,
    completedSequence: 104,
    requestSequence: 102,
  });
  expect(read.request).toBe(loadedReaction.request);
  expect(teamHasUnreadCompletion(read.team)).toBe(false);
  const reacted = reduceTeamState(read, {
    type: "reaction",
    revision: 202,
    sequence: 102,
    agentId: "reviewer",
    reaction: "love",
  });
  expect(reacted.request?.reactions).toEqual([
    otherReaction,
    { agentId: "reviewer", reaction: "love" },
  ]);
  expect(reacted.messages).toEqual(paged.messages);
  const clearedReaction = reduceTeamState(reacted, {
    type: "reaction",
    revision: 203,
    sequence: 102,
    agentId: "reviewer",
    reaction: null,
  });
  expect(clearedReaction.request?.reactions).toEqual([otherReaction]);
  const noReactions = reduceTeamState(clearedReaction, {
    type: "reaction",
    revision: 204,
    sequence: 102,
    agentId: "designer",
    reaction: null,
  });
  expect(noReactions.request?.reactions).toBeUndefined();
  const replied = reduceTeamState(noReactions, {
    type: "message",
    revision: 205,
    message: message(201),
  });
  expect(replied.request).toBeNull();
  expect(replied.team.requestSequence).toBeNull();
});

test("presence replaces the reconnect baseline or merges sparse live changes without advancing durable state", () => {
  const previous = {
    ...snapshot(),
    presence: { team: { state: "idle" as const }, removed: { state: "idle" as const } },
  };
  const presence = { team: { state: "working" as const } };
  const baseline = reduceTeamState(previous, { type: "resumed", presence });
  expect(baseline.presence).toBe(presence);
  const live = reduceTeamState(baseline, {
    type: "presence",
    presence: { reviewer: { state: "waiting", text: "Review" } },
  });
  expect(live.presence).toEqual({ ...presence, reviewer: { state: "waiting", text: "Review" } });
  expect(live).toEqual({ ...previous, presence: live.presence });
  expect(live.team).toBe(previous.team);
});

test("member departure removes its presence and recursively releases task ownership", () => {
  const member = { teamId: "team", id: "reviewer", name: "Reviewer" };
  const outcome = { artifactId: "session:reviewer:review.md", diff: { added: 12, removed: 3 } };
  const previous = snapshot();
  previous.members = [member];
  previous.presence[member.id] = { state: "working" };
  previous.team.tasks = [
    {
      id: "release",
      title: "Release",
      status: "in_progress",
      ownerId: member.id,
      children: [
        { id: "review", title: "Review", status: "pending", ownerId: member.id, ...outcome },
        { id: "ship", title: "Ship", status: "pending", ownerId: "team" },
      ],
    },
  ];
  const departed = reduceTeamState(previous, system(102, { type: "member_left", member }));
  expect(departed.members).toEqual([]);
  expect(departed.presence).toEqual({ team: { state: "idle" } });
  expect(departed.team.tasks).toEqual([
    {
      id: "release",
      title: "Release",
      status: "in_progress",
      children: [
        { id: "review", title: "Review", status: "pending", ...outcome },
        { id: "ship", title: "Ship", status: "pending", ownerId: "team" },
      ],
    },
  ]);
  expect(previous.team.tasks[0]!.ownerId).toBe(member.id);
});

test("local posts preserve server cursors and reconcile by identity across interleaved commits", () => {
  const previous = snapshot();
  previous.request = { ...message(1), sender: { type: "agent", agentId: "team" } };
  previous.messages[0] = previous.request;
  previous.team.requestSequence = 1;
  const local = {
    type: "message" as const,
    message: {
      id: "local",
      sender: { type: "user" as const },
      content: "Still sending",
      timestamp: "2026-10-03T20:01:00.000Z",
    },
  };
  const first = reduceTeamState(previous, local);
  const second = { ...local, message: { ...local.message, id: "second" } };
  const pending = reduceTeamState(first, second);
  expect(pending.messages.map(({ id }) => id)).toEqual([
    "message-1",
    "message-101",
    "local",
    "second",
  ]);
  expect(pending.revision).toBe(previous.revision);
  expect(pending.team).toBe(previous.team);
  expect(pending.request).toBe(previous.request);
  expect(previous.messages).toHaveLength(2);
  expect(reduceTeamState(pending, local)).toBe(pending);

  const concurrent = { ...message(102), sender: { type: "agent" as const, agentId: "team" } };
  const interleaved = reduceTeamState(pending, {
    type: "message",
    revision: 102,
    message: concurrent,
  });
  const committedSecond = { ...message(103), id: second.message.id };
  const acknowledged = reduceTeamState(interleaved, {
    type: "message",
    revision: 103,
    message: committedSecond,
  });
  const echo = {
    type: "message" as const,
    revision: 104,
    message: { ...message(104), id: local.message.id },
  };
  const next = reduceTeamState(acknowledged, echo);
  expect(next.messages).toEqual([...previous.messages, concurrent, committedSecond, echo.message]);
  expect(next.messages[0]).toBe(previous.messages[0]);
  expect(next.revision).toBe(104);
  expect(next.team).toMatchObject({
    latestSequence: 104,
    requestSequence: null,
    updatedAt: echo.message.timestamp,
  });
  expect(next.request).toBeNull();
  expect(reduceTeamState(next, local)).toBe(next);
  expect(reduceTeamState(next, echo)).toBe(next);
});

test("member edits replace and reorder profiles without duplicating membership or transcript", () => {
  const reviewer = { teamId: "team", id: "reviewer", name: "Reviewer", role: "Old role" };
  const builder = { teamId: "team", id: "builder", name: "Builder" };
  const joined = [
    system(102, { type: "member_joined", member: reviewer }),
    system(103, { type: "member_joined", member: builder }),
  ].reduce(reduceTeamState, snapshot());
  expect(joined.members).toEqual([builder, reviewer]);
  const updated = { teamId: "team", id: "reviewer", name: "Architect" };
  const edited = reduceTeamState(joined, { type: "member", revision: 104, member: updated });
  expect(edited.members).toEqual([updated, builder]);
  expect(edited.messages).toBe(joined.messages);
  expect(joined.members).toEqual([builder, reviewer]);
});

test.each(["team", "reviewer"])(
  "status updates %s without changing membership or history",
  (agentId) => {
    const previous = snapshot();
    previous.members = [{ teamId: "team", id: "reviewer", name: "Reviewer" }];
    const status = { state: "working" as const, text: "Reviewing", lookingAt: 1 };
    const next = reduceTeamState(previous, {
      type: "status",
      revision: 102,
      agentId,
      status,
    });
    expect([next.lead, ...next.members].find(({ id }) => id === agentId)?.status).toEqual(status);
    expect(next.members.map(({ id }) => id)).toEqual(["reviewer"]);
    expect(next.messages).toBe(previous.messages);
    expect(next.artifacts).toBe(previous.artifacts);
    const cleared = reduceTeamState(next, { type: "status", revision: 103, agentId });
    expect(
      [cleared.lead, ...cleared.members].find(({ id }) => id === agentId)?.status,
    ).toBeUndefined();
    expect([next.lead, ...next.members].find(({ id }) => id === agentId)?.status).toBe(status);
  },
);

test("sharing an artifact preserves its public URL and original share time when retitled", () => {
  const artifact = {
    file: machineFile("/workspace/plan.md"),
    title: "Plan",
    url: "/api/serve/machine/workspace/plan.md",
  };
  const shared = system(102, { type: "artifact_shared", actor: { type: "user" }, artifact });
  const first = reduceTeamState(snapshot(), shared);
  const retitled = system(103, {
    type: "artifact_shared",
    actor: { type: "user" },
    artifact: { ...artifact, title: "Release plan" },
  });
  retitled.message.timestamp = "2026-10-04T21:00:00.000Z";
  const next = reduceTeamState(first, retitled);
  const id = "machine:/workspace/plan.md";
  expect(first.artifacts).toEqual([{ ...artifact, id, sharedAt: shared.message.timestamp }]);
  expect(next.artifacts).toEqual([
    { ...artifact, id, title: "Release plan", sharedAt: shared.message.timestamp },
  ]);
});

test("new shares come first, while retitling keeps an artifact's place and archive state", () => {
  const share = (sequence: number, path: string, title = path) =>
    system(sequence, {
      type: "artifact_shared",
      actor: { type: "user" },
      artifact: { file: machineFile(path), title },
    });
  const shared = [share(102, "/plan.md"), share(103, "/spec.md")].reduce(
    reduceTeamState,
    snapshot(),
  );
  expect(shared.artifacts.map(({ title }) => title)).toEqual(["/spec.md", "/plan.md"]);
  const archived = reduceTeamState(shared, {
    type: "artifacts",
    revision: 104,
    artifacts: [shared.artifacts[0]!, { ...shared.artifacts[1]!, archived: true }],
  });
  const retitled = reduceTeamState(archived, share(105, "/plan.md", "Plan"));
  expect(retitled.artifacts).toMatchObject([
    { title: "/spec.md" },
    { title: "Plan", archived: true },
  ]);
});

test("arranging artifacts replaces them quietly", () => {
  const previous = snapshot();
  const artifacts = [
    {
      id: "machine:/plan.md",
      file: machineFile("/plan.md"),
      title: "Plan",
      sharedAt: "2026-10-03T20:00:00.000Z",
      archived: true as const,
    },
  ];
  const next = reduceTeamState(previous, { type: "artifacts", revision: 102, artifacts });
  expect(next.artifacts).toBe(artifacts);
  expect(next.revision).toBe(102);
  expect(next.team).toBe(previous.team);
  expect(next.messages).toBe(previous.messages);
  expect(reduceTeamState(next, { type: "artifacts", revision: 102, artifacts: [] })).toBe(next);
});

test("advice updates in place, open first and newest first, without transcript activity", () => {
  const previous = snapshot();
  const advice = (id: string, createdAt: string, status: "open" | "applied" = "open") => ({
    id,
    title: id,
    finding: "Evidence",
    action: { type: "message_lead" as const, content: "Change it" },
    authorId: "auditor",
    status,
    createdAt,
  });
  const older = reduceTeamState(previous, {
    type: "advice",
    revision: 102,
    advice: advice("older", "2026-11-01T00:00:00.000Z"),
  });
  const both = reduceTeamState(older, {
    type: "advice",
    revision: 103,
    advice: advice("newer", "2026-11-02T00:00:00.000Z"),
  });
  expect(both.advice.map(({ id }) => id)).toEqual(["newer", "older"]);
  const applied = reduceTeamState(both, {
    type: "advice",
    revision: 104,
    advice: advice("newer", "2026-11-02T00:00:00.000Z", "applied"),
  });
  expect(applied.advice.map(({ id, status }) => [id, status])).toEqual([
    ["older", "open"],
    ["newer", "applied"],
  ]);
  expect(applied.team).toBe(previous.team);
  expect(applied.messages).toBe(previous.messages);
});

test("a new share goes after pins, and retitling preserves a pin", () => {
  const shared = reduceTeamState(
    snapshot(),
    system(102, {
      type: "artifact_shared",
      actor: { type: "user" },
      artifact: { file: machineFile("/plan.md"), title: "Plan" },
    }),
  );
  const pinned = reduceTeamState(shared, {
    type: "artifacts",
    revision: 103,
    artifacts: [{ ...shared.artifacts[0]!, pinned: true }],
  });
  const arrived = reduceTeamState(
    pinned,
    system(104, {
      type: "artifact_shared",
      actor: { type: "user" },
      artifact: { file: machineFile("/notes.md"), title: "Notes" },
    }),
  );
  const retitled = reduceTeamState(
    arrived,
    system(105, {
      type: "artifact_shared",
      actor: { type: "user" },
      artifact: { file: machineFile("/plan.md"), title: "Updated plan" },
    }),
  );
  expect(retitled.artifacts).toMatchObject([
    { title: "Updated plan", pinned: true },
    { title: "Notes" },
  ]);
});

test("routine messages add, change in place, and delete routines", () => {
  const standup = { id: "standup", title: "CI", schedule: "0 9 * * 1-5", prompt: "Check CI" };
  const review = { ...standup, id: "review", title: "Review", prompt: "Review the week" };
  const added = [
    system(102, { type: "routine_scheduled", routine: standup }),
    system(103, { type: "routine_scheduled", routine: review }),
  ].reduce(reduceTeamState, snapshot());
  const edited = { ...standup, prompt: "Check CI and new issues" };
  const changed = reduceTeamState(added, system(104, { type: "routine_edited", routine: edited }));
  const removed = reduceTeamState(
    changed,
    system(105, { type: "routine_deleted", routine: review }),
  );
  expect(added.routines).toEqual([standup, review]);
  expect(changed.routines).toEqual([edited, review]);
  expect(removed.routines).toEqual([edited]);
});

test("history merges by identity and sequence without replacing current values", () => {
  const current = message(2);
  const earlier = message(1);
  const stale = { ...current, content: "Stale" };
  const page = [earlier, stale];
  const merged = mergeTeamMessages([current], page);
  expect(merged).toEqual([earlier, current]);
  expect(mergeTeamMessages(merged, page)).toBe(merged);
});
