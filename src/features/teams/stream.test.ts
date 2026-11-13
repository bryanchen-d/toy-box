import { expect, onTestFinished, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { teamLead, type TeamConversationMessage, type TeamList } from "./model";
import type { TeamObservationEvent, TeamState } from "./model";
import { teamQueries, type TeamQueryData } from "./queries";
import { teamMutations } from "./mutations";
import { mergeTeamMessages } from "./model/reducer";

const message = (sequence: number): TeamConversationMessage => ({
  id: `message-${sequence}`,
  sequence,
  timestamp: "2026-10-03T20:00:00.000Z",
  sender: { type: "user" },
  content: `Message ${sequence}`,
});
const snapshot: TeamState = {
  team: {
    id: "team",
    name: "Planning",
    paused: false,
    model: { provider: "codex", name: "gpt-5.5" },
    tasks: [],
    latestSequence: 101,
    seenThrough: 0,
    completedSequence: null,
    requestSequence: null,
    updatedAt: "2026-10-03T20:00:00.000Z",
  },
  revision: 101,
  lead: teamLead("team"),
  members: [],
  messages: [message(101)],
  artifacts: [],
  routines: [],
  advice: [],
  request: null,
  presence: {},
};

test.each([undefined, 0])(
  "arrival uses the authoritative snapshot, with cursor %s",
  async (revision) => {
    const stream = openStream(
      revision === undefined
        ? undefined
        : {
            ...snapshot,
            team: { ...snapshot.team, latestSequence: 0 },
            revision,
            messages: [],
            optimisticMessageIds: ["stale-local-post"],
            arrival: { id: 1, unreadAfter: null },
          },
    );
    const acknowledged = { ...snapshot.team, latestSequence: 102, seenThrough: 102 };
    stream.client.setQueryData(teamQueries.listKey(), { teams: [acknowledged], members: [] });
    const connection = await stream.nextConnection();
    expect(connection.url).toBe(`/api/v1/teams/team${revision === undefined ? "" : "?after=0"}`);
    connection.send({ type: "snapshot", state: snapshot });
    await stream.waitFor((view) => view?.revision === 101);
    expect(stream.view()!.arrival.unreadAfter).toBe(0);
    expect(stream.view()!.optimisticMessageIds).toBeUndefined();
    expect(stream.client.getQueryData<TeamList>(teamQueries.listKey())?.teams).toEqual([
      acknowledged,
    ]);
  },
);

test("replayed reads establish arrival only at the resumption and retain paging and optimism", async () => {
  const arrival = { id: 1, unreadAfter: 0 };
  const stream = openStream({ ...snapshot, arrival });
  const connection = await stream.nextConnection();
  connection.send({ type: "message", revision: 102, message: message(102) });
  await stream.waitFor((view) => view?.revision === 102);
  stream.client.setQueryData<TeamQueryData>(stream.key, (view) => ({
    ...view!,
    messages: mergeTeamMessages(view!.messages, [message(1)]),
  }));
  await teamMutations.post().onMutate!(
    { teamId: snapshot.team.id, id: "optimistic", content: "Still sending" },
    { client: stream.client, meta: undefined },
  );
  expect(stream.view()!.optimisticMessageIds).toEqual(["optimistic"]);
  connection.send({ type: "read", revision: 103, seenThrough: 102 });
  await stream.waitFor((view) => view?.revision === 103);
  expect(stream.view()!.arrival).toEqual(arrival);
  connection.send({ type: "resumed", presence: {} });
  await stream.waitFor((view) => view?.arrival.id !== arrival.id);
  expect(stream.view()!.arrival.unreadAfter).toBeNull();
  expect(stream.view()!.optimisticMessageIds).toEqual(["optimistic"]);
  expect(stream.view()!.messages.map(({ id }) => id)).toEqual([
    "message-1",
    "message-101",
    "message-102",
    "optimistic",
  ]);
  const arrived = stream.view()!.arrival;
  connection.send({ type: "presence", presence: { team: { state: "working" } } });
  await stream.waitFor((view) => view?.presence.team?.state === "working");
  expect(stream.view()!.arrival).toEqual(arrived);
  connection.send({
    type: "message",
    revision: 104,
    message: { ...message(104), id: "optimistic", content: "Still sending" },
  });
  await stream.waitFor((view) => view?.revision === 104);
  expect(stream.view()!.optimisticMessageIds).toEqual([]);
  expect(stream.view()!.messages.filter(({ id }) => id === "optimistic")).toHaveLength(1);
});

test("deletion before bootstrap completes observation and removes the catalog entry", async () => {
  const stream = openStream();
  stream.client.setQueryData(teamQueries.listKey(), {
    teams: [snapshot.team],
    members: [{ teamId: snapshot.team.id, id: "reviewer", name: "Reviewer" }],
  });
  const connection = await stream.nextConnection();
  connection.send({ type: "deleted", teamId: snapshot.team.id });
  await stream.finished;
  expect(stream.view()).toBeNull();
  expect(stream.client.getQueryData<TeamList>(teamQueries.listKey())).toEqual({
    teams: [],
    members: [],
  });
});

test("unexpected EOF reconnects from the last applied revision", async () => {
  const stream = openStream();
  const first = await stream.nextConnection();
  first.send({ type: "snapshot", state: snapshot });
  first.send({ type: "message", revision: 102, message: message(102) });
  await stream.waitFor((view) => view?.revision === 102);
  first.end();
  const retried = await stream.nextConnection();
  expect(retried.url).toBe("/api/v1/teams/team?after=102");
});

type Connection = {
  url: string;
  send(event: TeamObservationEvent): void;
  end(): void;
};

function openStream(cached?: TeamQueryData) {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  const options = { ...teamQueries.detail(snapshot.team.id), retryDelay: 0 };
  const key = options.queryKey;
  if (cached) client.setQueryData(key, cached);
  let connected = Promise.withResolvers<Connection>();
  const respond = Object.assign(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      const signal = init!.signal!;
      let controller: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      const connection = {
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        send(event: TeamObservationEvent) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        },
        end() {
          controller.close();
        },
      };
      connected.resolve(connection);
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    },
    globalThis.fetch,
  );
  const fetch = spyOn(globalThis, "fetch").mockImplementation(respond);
  const finished = client.query(options);
  void finished.catch(() => {}); // Other cases deliberately cancel their open stream during cleanup.
  onTestFinished(() => {
    client.clear();
    fetch.mockRestore();
  });
  const view = () => client.getQueryData<TeamQueryData | null>(key);
  return {
    client,
    key,
    finished,
    view,
    nextConnection: async () => {
      const connection = await connected.promise;
      connected = Promise.withResolvers<Connection>();
      return connection;
    },
    waitFor: (ready: (view: TeamQueryData | null | undefined) => boolean): Promise<void> => {
      if (ready(view())) return Promise.resolve();
      return new Promise((resolve) => {
        const stop = client.getQueryCache().subscribe(() => {
          if (!ready(view())) return;
          stop();
          resolve();
        });
      });
    },
  };
}
