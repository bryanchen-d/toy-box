import { expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { teamLead, type Team, type TeamList } from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { teamQueries, type TeamQueryData } from "@teams/queries";
import { applyTeamListEvent, loadTeamHistory } from "./queryCache";
import type { TeamConversationMessage, TeamState } from "./model";

const team: Team = {
  id: "team",
  name: "Planning",
  paused: false,
  purpose: "Prepare the release plan.",
  model: { provider: "copilot", name: "gpt-5.5" },
  tasks: [],
  latestSequence: 0,
  seenThrough: 0,
  completedSequence: null,
  requestSequence: null,
  updatedAt: "2026-09-05T12:00:00.000Z",
};

const message: TeamConversationMessage = {
  id: "latest",
  sequence: 101,
  timestamp: team.updatedAt,
  sender: { type: "user" },
  content: "Latest",
};
const older = { ...message, id: "older", sequence: 100 };
const snapshot: TeamQueryData = {
  arrival: { id: 1, unreadAfter: 0 },
  team: { ...team, latestSequence: message.sequence },
  request: null,
  presence: {},
  revision: 101,
  lead: teamLead(team.id),
  members: [],
  messages: [message],
  artifacts: [],
  routines: [],
  advice: [],
};
const detailKey = teamQueries.detail(team.id).queryKey;

test("live events do not replace initial catalog loading with a partial list", () => {
  const client = createQueryClient();
  applyTeamListEvent(client, { type: "team.upserted", team });
  expect(client.getQueryData(teamQueries.listKey())).toBeUndefined();
});

test("deleting a Team retires its on-demand usage query as well as its detail", () => {
  const client = createQueryClient();
  const usageKey = teamQueries.usage(team.id).queryKey;
  client.setQueryData(usageKey, { [team.id]: { aiCredits: 1, status: "complete" } });
  client.setQueryData(detailKey, snapshot);
  applyTeamListEvent(client, { type: "team.deleted", teamId: team.id });
  expect(client.getQueryState(usageKey)).toBeUndefined();
  expect(client.getQueryState(detailKey)).toBeUndefined();
});

test("catalog membership follows workspace events without touching detail state", () => {
  const client = createQueryClient();
  const key = teamQueries.listKey();
  client.setQueryData(key, { teams: [team], members: [] });
  client.setQueryData(detailKey, snapshot);
  const member = { id: "reviewer", teamId: team.id, name: "Reviewer" };
  applyTeamListEvent(client, { type: "team.member.upserted", member });
  applyTeamListEvent(client, {
    type: "team.member.upserted",
    member: { ...member, name: "Ada" },
  });
  expect(client.getQueryData<TeamList>(key)?.members).toEqual([{ ...member, name: "Ada" }]);
  applyTeamListEvent(client, {
    type: "team.member.deleted",
    teamId: team.id,
    agentId: member.id,
  });
  expect(client.getQueryData<TeamList>(key)).toEqual({ teams: [team], members: [] });
  expect(client.getQueryState(key)?.isInvalidated).toBe(false);
  expect(client.getQueryData<TeamQueryData>(detailKey)).toEqual(snapshot);
});

test("concurrent history reads preserve a reaction posted while the older page was loading", async () => {
  const client = createQueryClient();
  client.setQueryData(detailKey, snapshot);
  const held = Promise.withResolvers<Pick<TeamState, "revision" | "messages">>();
  const updated = { ...older, reactions: [{ agentId: "reviewer", reaction: "agree" as const }] };
  mockHistory()
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue({ revision: 102, messages: [updated] });
  const first = loadTeamHistory(client, team.id);
  client.setQueryData<TeamQueryData>(detailKey, {
    ...snapshot,
    revision: 102,
  });
  const second = loadTeamHistory(client, team.id);
  held.resolve({ revision: 101, messages: [older] });
  await Promise.all([first, second]);
  expect(client.getQueryData<TeamState>(detailKey)?.messages).toEqual([updated, message]);
});

test("revealing an older message loads consecutive pages through its sequence", async () => {
  const client = createQueryClient();
  client.setQueryData(detailKey, snapshot);
  const target = { ...older, id: "target", sequence: 99 };
  const reads = mockHistory()
    .mockResolvedValueOnce({ revision: 101, messages: [older] })
    .mockResolvedValueOnce({ revision: 101, messages: [target] });
  await loadTeamHistory(client, team.id, target.sequence);
  expect(client.getQueryData<TeamState>(detailKey)?.messages).toEqual([target, older, message]);
  expect(reads.mock.calls.map(([before]) => before)).toEqual([101, 100]);
});

test("history completion cannot recreate a deleted Team", async () => {
  const client = createQueryClient();
  client.setQueryData(detailKey, snapshot);
  const held = Promise.withResolvers<Pick<TeamState, "revision" | "messages">>();
  mockHistory().mockReturnValue(held.promise);
  const pending = loadTeamHistory(client, team.id);
  applyTeamListEvent(client, { type: "team.deleted", teamId: team.id });
  held.resolve({ revision: 101, messages: [older] });
  await pending;
  expect(client.getQueryData(detailKey)).toBeUndefined();
});

test("a request jump survives repeated overtaken pages without advancing the stream cursor", async () => {
  const client = createQueryClient();
  client.setQueryData(detailKey, snapshot);
  let revision = snapshot.revision;
  let reads = 0;
  const reader = mockHistory().mockImplementation(async () => {
    const pageRevision = revision;
    if (++reads <= 3)
      client.setQueryData<TeamQueryData>(detailKey, {
        ...snapshot,
        revision: ++revision,
      });
    return { revision: pageRevision, messages: [older] };
  });
  await loadTeamHistory(client, team.id, older.sequence);
  expect(client.getQueryData(detailKey)?.messages).toEqual([older, message]);
  expect(reads).toBe(4);

  client.setQueryData(detailKey, snapshot);
  reader.mockResolvedValue({ revision: 105, messages: [older] });
  await loadTeamHistory(client, team.id);
  expect(client.getQueryData(detailKey)).toMatchObject({
    revision: 101,
    messages: [older, message],
  });
});

test.each(["team.upserted", "team.deleted"] as const)(
  "%s replaces an in-flight catalog read without resurrecting old state",
  async (type) => {
    const client = createQueryClient();
    const held = Promise.withResolvers<TeamList>();
    const updated = { ...team, name: "Updated planning" };
    const other = { ...team, id: "unrelated" };
    const member = { teamId: team.id, id: "reviewer", name: "Reviewer" };
    const otherMember = { teamId: other.id, id: "builder", name: "Builder" };
    const latest = {
      teams: type === "team.upserted" ? [updated, other] : [other],
      members: type === "team.upserted" ? [member, otherMember] : [otherMember],
    };
    const stale = { teams: [team, other], members: [member, otherMember] };
    client.setQueryData<TeamList>(teamQueries.listKey(), stale);
    let reads = 0;
    const pending = client.query({
      ...teamQueries.list(),
      staleTime: 0,
      queryFn: () => (++reads === 1 ? held.promise : Promise.resolve(latest)),
    });
    applyTeamListEvent(
      client,
      type === "team.upserted" ? { type, team: updated } : { type, teamId: team.id },
    );
    expect(client.getQueryData<TeamList>(teamQueries.listKey())).toEqual(latest);
    held.resolve(stale);
    await pending;
    expect(client.getQueryData<TeamList>(teamQueries.listKey())).toEqual(latest);
  },
);

test("create and edit responses invalidate instead of overwriting newer catalog state", async () => {
  const client = createQueryClient();
  const key = teamQueries.listKey();
  const deleted: TeamList = { teams: [], members: [] };
  client.setQueryData(key, deleted);

  await teamMutations.create().onSuccess!(team, { name: team.name, model: team.model }, undefined, {
    client,
    meta: undefined,
  });
  expect(client.getQueryData<TeamList>(key)).toEqual(deleted);
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);

  const current: TeamList = {
    teams: [{ ...team, preview: { kind: "url", url: "https://current.example" } }],
    members: [],
  };
  client.setQueryData(key, current);
  await teamMutations.edit().onSuccess!(team, { teamId: team.id, name: team.name }, undefined, {
    client,
    meta: undefined,
  });
  expect(client.getQueryData<TeamList>(key)).toEqual(current);
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
});

function mockHistory() {
  const read = mock<(before: number) => Promise<Pick<TeamState, "revision" | "messages">>>();
  const options = teamQueries.messagesBefore;
  const query = spyOn(teamQueries, "messagesBefore").mockImplementation((id, before) => ({
    ...options(id, before),
    queryFn: () => read(before),
  }));
  onTestFinished(() => query.mockRestore());
  return read;
}

function createQueryClient(): QueryClient {
  const client = new QueryClient();
  onTestFinished(() => client.clear());
  return client;
}
