import { expect, onTestFinished, spyOn, test } from "bun:test";
import type { TeamMessage, TeamObservationEvent } from "@teams/model";
import { broadcast } from "@workspace/server/events";
import { setSessionStatus } from "@workspace/server/state";
import { deleteSessionState } from "@workspace/server/state/sessions";
import * as database from "@/server/database";
import {
  getTeamHistoryResponse,
  getTeamResponse,
  markTeamReadResponse,
  postTeamMessageResponse,
} from "./api";
import { TeamDatabase } from "./database";
import { resolveEventResources } from "./resources";
import { publishTeamEvent, releaseTeamEvents } from "./events";
import { getTeamSnapshot, streamTeam } from "./stream";
import { teamAgent, createStoredTeam } from "./testFixtures";

async function openTeam() {
  const db = await database.createTestDatabase();
  const access = spyOn(database, "getStateDatabase").mockResolvedValue(db);
  const teams = new TeamDatabase(db);
  const team = await createStoredTeam(teams, {
    name: "Studio",
    model: { provider: "copilot", name: "gpt-5.5" },
  });
  onTestFinished(async () => {
    access.mockRestore();
    releaseTeamEvents(team.id);
    deleteSessionState(team.id);
    await db.close();
  });
  return { team, teams };
}

function observe(teamId: string, afterRevision?: number) {
  const events: TeamObservationEvent[] = [];
  const waiters: Array<(event: TeamObservationEvent) => void> = [];
  let closed = false;
  const stop = streamTeam(
    teamId,
    (event) => {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else events.push(event);
    },
    () => {
      closed = true;
    },
    afterRevision,
  );
  onTestFinished(stop);
  return {
    stop,
    events,
    get closed() {
      return closed;
    },
    next(): Promise<TeamObservationEvent> {
      const event = events.shift();
      return event ? Promise.resolve(event) : new Promise((resolve) => waiters.push(resolve));
    },
  };
}

test("snapshots combine public Team facts with live presence without exposing private worker metadata", async () => {
  const { team, teams } = await openTeam();
  const worker = teamAgent(team.id, "reviewer", "Reviewer");
  worker.metadata = { seenThrough: 72 };
  const { member } = await teams.createMember(worker);
  onTestFinished(() => deleteSessionState(member.id));
  setSessionStatus(team.id, "running");

  const file = { kind: "session" as const, sessionId: team.id, path: "docs/Project plan.md" };
  await teams.shareArtifact({
    teamId: team.id,
    file,
    title: "Plan",
    actor: { type: "user" },
  });
  const attachments = ["/tmp/a #1.png", { mimeType: "image/png", base64: "AAEC" }, "/tmp/last.png"];
  await teams.appendMessage({
    request: true,
    id: "images",
    teamId: team.id,
    sender: { type: "agent", agentId: team.id },
    content: "See these images",
    attachments,
  });
  const snapshot = await getTeamSnapshot(team.id);
  const artifact = {
    id: `session:${team.id}:docs/Project plan.md`,
    url: `/api/serve/${team.id}/docs/Project%20plan.md`,
  };
  expect(snapshot?.artifacts[0]).toMatchObject({ ...artifact, file, title: "Plan" });
  // Live shares carry the same identity, so clients match task outcomes either way.
  const share = snapshot?.messages.find(
    ({ content }) => typeof content === "object" && content.type === "artifact_shared",
  );
  expect(share).toMatchObject({ content: { artifact } });
  expect<TeamMessage | null | undefined>(snapshot?.request).toEqual(
    snapshot?.messages.find(({ id }) => id === "images"),
  );
  expect(snapshot?.request).toMatchObject({
    attachments: [
      { name: "a #1.png", url: "/api/serve/machine/tmp/a%20%231.png" },
      { mimeType: "image/png", base64: "AAEC" },
      { name: "last.png", url: "/api/serve/machine/tmp/last.png" },
    ],
  });
  expect(snapshot).toMatchObject({
    team: { id: team.id, name: "Studio" },
    members: [{ id: member.id, name: "Reviewer" }],
    presence: { [team.id]: { state: "working" }, [member.id]: { state: "idle" } },
  });
  expect(snapshot?.members[0]).not.toHaveProperty("seenThrough");
  expect(snapshot?.members[0]).not.toHaveProperty("sessionId");
  expect(snapshot?.lead).not.toHaveProperty("metadata");
  expect(snapshot).not.toHaveProperty("sessionStates");
});

test("a reply committed after the durable read cannot advance the snapshot beyond its transcript", async () => {
  const { team, teams } = await openTeam();
  const request = await teams.appendMessage({
    id: "pending-request",
    teamId: team.id,
    sender: { type: "agent", agentId: team.id },
    content: "Which direction?",
    request: true,
  });
  const before = (await teams.getTeam(team.id))!;
  const transaction = database.inStateTransaction;
  // Commit the reply immediately after the first read transaction, before its caller resumes.
  // Separately reading metadata or the request afterward would produce a torn public snapshot.
  const reads = spyOn(database, "inStateTransaction").mockImplementationOnce(
    async (db, operation) => {
      const result = await transaction(db, operation);
      await teams.appendMessage({
        id: "interleaved-reply",
        teamId: team.id,
        sender: { type: "user" },
        content: "The eastern path.",
      });
      return result;
    },
  );
  onTestFinished(() => reads.mockRestore());

  const snapshot = (await getTeamSnapshot(team.id))!;
  expect(snapshot.team.latestSequence).toBe(before.latestSequence);
  expect(snapshot.messages.at(-1)?.sequence).toBe(snapshot.team.latestSequence);
  expect(snapshot.team.requestSequence).toBe(1);
  expect(snapshot.request?.id).toBe(request.message.id);
  expect(snapshot.messages.some(({ id }) => id === "interleaved-reply")).toBe(false);
  expect(await teams.getTeam(team.id)).toMatchObject({
    latestSequence: before.latestSequence + 1,
    requestSequence: null,
  });
});

test("cached reconnects replay before presence; an expired cursor replaces history", async () => {
  const { team, teams } = await openTeam();
  const changed = await teams.updateTeam(team.id, {
    tasks: [{ id: "work", title: "Work added while disconnected", status: "pending" }],
  });
  for (const event of changed.events) publishTeamEvent(team.id, resolveEventResources(event));
  const reads = spyOn(TeamDatabase.prototype, "getSnapshot");
  onTestFinished(() => reads.mockRestore());
  const client = observe(team.id, 0);
  expect(await client.next()).toEqual(resolveEventResources(changed.events[0]!));
  expect(await client.next()).toEqual({
    type: "resumed",
    presence: { [team.id]: { state: "idle" } },
  });
  client.stop();
  const current = observe(team.id, changed.events[0]!.revision);
  expect(await current.next()).toMatchObject({ type: "resumed" });
  expect(reads).not.toHaveBeenCalled();
  current.stop();
  releaseTeamEvents(team.id);
  const expired = observe(team.id, 0);
  expect(await expired.next()).toMatchObject({
    type: "snapshot",
    state: { team: changed.team },
  });
  expect(reads).toHaveBeenCalledTimes(1);
});

test("live events and presence send only changed facts without rereading durable state", async () => {
  const { team, teams } = await openTeam();
  const client = observe(team.id, 0);
  expect(await client.next()).toMatchObject({ type: "resumed" });
  const snapshots = spyOn(TeamDatabase.prototype, "getSnapshot");
  const rosters = spyOn(TeamDatabase.prototype, "getRoster");
  onTestFinished(() => {
    snapshots.mockRestore();
    rosters.mockRestore();
  });
  const status = await teams.setAgentStatus(team.id, { state: "waiting", text: "A reply" });
  publishTeamEvent(team.id, status!.events[0]!);
  expect(await client.next()).toMatchObject({ type: "status" });
  expect(await client.next()).toEqual({
    type: "presence",
    presence: { [team.id]: { state: "waiting", text: "A reply" } },
  });
  setSessionStatus(team.id, "running");
  expect(await client.next()).toEqual({
    type: "presence",
    presence: { [team.id]: { state: "working" } },
  });
  setSessionStatus(team.id, "background");
  expect(await client.next()).toEqual({
    type: "presence",
    presence: { [team.id]: { state: "waiting", text: "A reply" } },
  });
  setSessionStatus(team.id, "running");
  expect(await client.next()).toEqual({
    type: "presence",
    presence: { [team.id]: { state: "working" } },
  });
  setSessionStatus(team.id, "idle");
  expect(await client.next()).toEqual({
    type: "presence",
    presence: { [team.id]: { state: "waiting", text: "A reply" } },
  });
  broadcast({ type: "team.upserted", team });
  await Bun.sleep(0);
  expect(client.events).toEqual([]);
  expect(snapshots).not.toHaveBeenCalled();
  expect(rosters).not.toHaveBeenCalled();
  broadcast({ type: "team.deleted", teamId: "unrelated" });
  expect(client.closed).toBe(false);
  broadcast({ type: "team.deleted", teamId: team.id });
  expect(await client.next()).toEqual({ type: "deleted", teamId: team.id });
  expect(client.closed).toBe(true);
});

test.each([undefined, 0])(
  "a change during connection follows the coherent initial view (cursor %s)",
  async (after) => {
    const { team, teams } = await openTeam();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const transaction = database.inStateTransaction;
    const held = spyOn(database, "inStateTransaction").mockImplementationOnce(
      async (db, operation) => {
        const result = await transaction(db, operation);
        entered.resolve();
        await release.promise;
        return result;
      },
    );
    onTestFinished(() => {
      release.resolve();
      held.mockRestore();
    });
    const client = observe(team.id, after);
    await entered.promise;
    const change = await teams.setAgentStatus(team.id, { state: "waiting", text: "A reply" });
    publishTeamEvent(team.id, change!.events[0]!);
    release.resolve();
    expect(await client.next()).toMatchObject({
      type: after === undefined ? "snapshot" : "resumed",
    });
    expect(await client.next()).toEqual(change!.events[0]!);
    expect(await client.next()).toMatchObject({
      type: "presence",
      presence: { [team.id]: { state: "waiting", text: "A reply" } },
    });
  },
);

test("disconnecting during a snapshot suppresses its result and later events", async () => {
  const { team, teams } = await openTeam();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const original = teams.getSnapshot.bind(teams);
  const reads = spyOn(TeamDatabase.prototype, "getSnapshot").mockImplementationOnce(
    async (...args) => {
      const state = await original(...args);
      entered.resolve();
      await release.promise;
      finished.resolve();
      return state;
    },
  );
  onTestFinished(() => {
    release.resolve();
    reads.mockRestore();
  });
  const events: TeamObservationEvent[] = [];
  const stop = streamTeam(
    team.id,
    (event) => events.push(event),
    () => {},
  );
  onTestFinished(stop);
  await entered.promise;
  stop();
  release.resolve();
  await finished.promise;
  broadcast({ type: "team.upserted", team });
  publishTeamEvent(team.id, { type: "status", revision: 1, agentId: team.id });
  await Bun.sleep(0);
  expect(events).toEqual([]);
});

test("the HTTP stream snapshots, resumes by cursor, and ends for missing Teams", async () => {
  const { team } = await openTeam();
  const expected = (await getTeamSnapshot(team.id))!;
  const abort = new AbortController();
  onTestFinished(() => abort.abort());
  const stream = await getTeamResponse(
    team.id,
    new Request("http://localhost/team", {
      signal: abort.signal,
    }),
  );
  expect(stream.headers.get("content-type")).toStartWith("text/event-stream");
  const reader = stream.body!.getReader();
  expect(await nextEvent(reader)).toEqual({ type: "snapshot", state: expected });
  abort.abort();
  expect((await reader.read()).done).toBe(true);
  const resumed = await getTeamResponse(
    team.id,
    new Request("http://localhost/team?after=999", {
      headers: { Accept: "text/event-stream", "Last-Event-ID": String(expected.revision) },
    }),
  );
  const resumedReader = resumed.body!.getReader();
  expect(await nextEvent(resumedReader)).toMatchObject({ type: "resumed" });
  await resumedReader.cancel();
  for (const query of ["?after=", "?after=%20%20"]) {
    const blank = await getTeamResponse(
      team.id,
      new Request(`http://localhost/team${query}`, {
        headers: { Accept: "text/event-stream" },
      }),
    );
    const reader = blank.body!.getReader();
    expect(await nextEvent(reader)).toEqual({ type: "snapshot", state: expected });
    await reader.cancel();
  }
  for (const cursor of ["", "?after=0"]) {
    const missing = await getTeamResponse(
      "missing",
      new Request(`http://localhost/team${cursor}`, {
        headers: { Accept: "text/event-stream" },
      }),
    );
    const reader = missing.body!.getReader();
    expect(await nextEvent(reader)).toEqual({ type: "deleted", teamId: "missing" });
    expect((await reader.read()).done).toBe(true);
  }
});

test("snapshot failures terminate observation without exposing private errors", async () => {
  const { team } = await openTeam();
  const reads = spyOn(TeamDatabase.prototype, "getSnapshot").mockRejectedValue(
    new Error("Private database details"),
  );
  const errors = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => {
    reads.mockRestore();
    errors.mockRestore();
  });
  const closed = Promise.withResolvers<void>();
  const events: TeamObservationEvent[] = [];
  const stop = streamTeam(team.id, (event) => events.push(event), closed.resolve);
  onTestFinished(stop);
  await closed.promise;
  broadcast({ type: "team.upserted", team });
  publishTeamEvent(team.id, { type: "status", revision: 1, agentId: team.id });
  await Bun.sleep(0);
  expect(events).toEqual([]);
});

test("HTTP publication returns the canonical user receipt and maps duplicate IDs to conflict", async () => {
  const { team } = await openTeam();
  const message = { id: "public", content: "Please continue @http-no-recipient" };
  const response = await postTeamMessageResponse(team.id, post(message));
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({
    version: 1,
    message: { ...message, sequence: 1, sender: { type: "user" } },
  });
  const history = await getTeamHistoryResponse(
    team.id,
    new Request("http://localhost/team/messages?before=2"),
  );
  expect(history.headers.get("cache-control")).toBe("no-store");
  expect(await history.json()).toMatchObject({ revision: 1, messages: [{ id: message.id }] });
  expect(
    (
      await getTeamHistoryResponse(
        "missing",
        new Request("http://localhost/team/messages?before=2"),
      )
    ).status,
  ).toBe(404);
  const duplicate = await postTeamMessageResponse(team.id, post(message));
  expect(duplicate.status).toBe(409);
});

test("the HTTP read command returns its cursor for changes and no-ops", async () => {
  const { team, teams } = await openTeam();
  await teams.appendMessage({
    id: "unread",
    teamId: team.id,
    sender: { type: "user" },
    content: "Hello",
  });
  const response = await markTeamReadResponse(team.id, post({ sequence: 1 }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ version: 1, seenThrough: 1 });
  const unchanged = await markTeamReadResponse(team.id, post({ sequence: 1 }));
  expect(await unchanged.json()).toEqual({ version: 1, seenThrough: 1 });
  expect((await markTeamReadResponse("missing", post({ sequence: 0 }))).status).toBe(404);
});

test("HTTP rejects malformed bodies, team overrides, unsupported content types and missing Teams", async () => {
  const { team } = await openTeam();
  for (const body of [null, [], {}, { id: "message", content: "Hello", teamId: "other" }]) {
    expect((await postTeamMessageResponse(team.id, post(body))).status).toBe(400);
  }
  for (const before of ["", "0", "-1", "1.5", "bad"]) {
    const response = await getTeamHistoryResponse(
      team.id,
      new Request(`http://localhost/team/messages?before=${before}`),
    );
    expect(response.status).toBe(400);
  }
  const malformed = await postTeamMessageResponse(
    team.id,
    new Request("http://localhost/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    }),
  );
  expect(malformed.status).toBe(400);
  const unsupported = await postTeamMessageResponse(
    team.id,
    new Request("http://localhost/team", { method: "POST", body: "hello" }),
  );
  expect(unsupported.status).toBe(400);
  expect((await postTeamMessageResponse("missing", post({ id: "m", content: "Hi" }))).status).toBe(
    404,
  );
});

function post(body: unknown): Request {
  return new Request("http://localhost/team/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function nextEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<TeamObservationEvent> {
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("Team stream closed before its next event");
    const data = decoder
      .decode(value)
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (data) return JSON.parse(data.slice(6));
  }
}
