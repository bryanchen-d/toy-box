import { expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoredTeam } from "@teams/server/testFixtures";
import { createTestDatabase } from "@/server/database";
import * as sessionRuntime from "@sessions/server/runtime";
import * as workspaceEvents from "@workspace/server/events";
import { normalizeToolResult, type Tool } from "@sessions/server/tools/definition";
import { CONNECTOR_PROTOCOL_VERSION, type ConnectorEvent } from "@connectors/model";

let currentDb: Bun.SQL | undefined;

mock.module("@/server/database", () => ({
  getStateDatabase: async () => {
    if (!currentDb) throw new Error("Test database has not been opened");
    return currentDb;
  },
}));

const { TeamDatabase } = await import("./database");
const { ConnectorDatabase } = await import("@connectors/server/database");
const { postTeamMessage, sendTeamMessageFromAgent } = await import("./index");
const { applyConnectorEvent, noteUndeliveredConnectorMessage, listConnectorDirectory } =
  await import("./connectors");
const { teamTools } = await import("./tools");

/** What an ordinary session reads from read_team. */
async function readTeam(teamId: string) {
  const tool = teamTools.find(({ name }) => name === "read_team") as Tool;
  const result = normalizeToolResult(
    await tool.handler(tool.parameters!.parse({ teamId }), {
      sessionId: "reader",
      toolCallId: "read",
      toolName: "read_team",
      arguments: { teamId },
    }),
  );
  const [content] = result.content;
  if (content?.type !== "text") throw new Error("Expected a text tool result.");
  return JSON.parse(content.text) as { messages: { content: unknown; from?: string }[] };
}

async function open() {
  const db = await createTestDatabase();
  currentDb = db;
  onTestFinished(async () => {
    await db.close();
    currentDb = undefined;
  });
  const teams = new TeamDatabase(db);
  const connectors = new ConnectorDatabase(db);
  const team = await createStoredTeam(teams, {
    name: "Docs",
    purpose: "Ship the release notes.",
    model: { provider: "copilot", name: "gpt-5.5" },
  });
  const connector = await connectors.create({
    name: "BryanBot",
    transport: { type: "http", url: "http://127.0.0.1:4243" },
  });
  spyOn(workspaceEvents, "broadcast").mockImplementation(() => {});
  const wakes = spyOn(sessionRuntime, "deliverSessionMessage").mockResolvedValue({
    disposition: "started",
    waitForCompletion: async () => ({ status: "completed" }),
  });
  onTestFinished(() => mock.restore());
  return { teams, connectors, team, connector, wakes };
}

function event(content: string, extra: Partial<ConnectorEvent> = {}): ConnectorEvent {
  return {
    version: CONNECTOR_PROTOCOL_VERSION,
    id: crypto.randomUUID(),
    conversationId: "conversation-1",
    content,
    ...extra,
  };
}

async function queued(connectors: InstanceType<typeof ConnectorDatabase>, connectorId: string) {
  return (await connectors.dueMessages(connectorId, new Date(Date.now() + 60_000))).map(
    ({ message }) => message,
  );
}

test("opening a message with a connector's handle sends it the message, and its thread is one conversation", async () => {
  const { teams, connectors, team, connector, wakes } = await open();
  const root = await postTeamMessage({
    id: "root",
    teamId: team.id,
    content: "@bryanbot post the release notes in #vscode-dev",
  });
  const [sent] = await queued(connectors, connector.id);
  expect(sent).toEqual({
    version: 1,
    id: "root",
    conversationId: expect.any(String),
    sender: { kind: "user", name: "Owner" },
    origin: { kind: "team", teamId: team.id, teamName: "Docs" },
    content: "@bryanbot post the release notes in #vscode-dev",
  });
  // Addressing only a connector names no agent, so it wakes nobody in the team.
  expect(wakes).not.toHaveBeenCalled();
  expect(await teams.getConnectorThread(connector.id, sent!.conversationId)).toEqual({
    teamId: team.id,
    threadSequence: root.sequence,
  });

  await connectors.remove(connector.id, "root");
  await sendTeamMessageFromAgent(team.id, {
    content: "@bryanbot also mention the known issue",
    threadSequence: root.sequence,
  });
  const [followUp] = await queued(connectors, connector.id);
  expect(followUp).toMatchObject({
    conversationId: sent!.conversationId,
    sender: { kind: "agent", name: "Lead" },
  });
});

test("talking about a connector sends it nothing, and the message routes as if unmentioned", async () => {
  const { connectors, team, connector, wakes } = await open();
  const ask = await postTeamMessage({
    id: "ask",
    teamId: team.id,
    content: "Can you ask @bryanbot to DM me?",
  });
  expect(wakes).toHaveBeenCalledTimes(1);
  await sendTeamMessageFromAgent(team.id, {
    content: "Done. That post went through @bryanbot.",
    threadSequence: ask.sequence,
  });
  expect(wakes).toHaveBeenCalledTimes(1);
  expect(await queued(connectors, connector.id)).toEqual([]);
});

test("a connector's reply lands once in its thread as the connector, and wakes the lead", async () => {
  const { teams, connectors, team, connector, wakes } = await open();
  const root = await postTeamMessage({ id: "root", teamId: team.id, content: "@bryanbot hi" });
  const [sent] = await queued(connectors, connector.id);
  const reply = event("Posted. I'll pass along replies.", {
    conversationId: sent!.conversationId,
    origin: { kind: "slack", requester: { id: "U2", name: "alex", isOwner: false } },
  });

  await applyConnectorEvent(connector, reply);
  await applyConnectorEvent(connector, reply);

  const messages = await teams.listThread(team.id, root.sequence);
  expect(messages.slice(1)).toEqual([
    expect.objectContaining({
      id: `${connector.id}:${reply.id}`,
      sender: { type: "connector", connectorId: connector.id },
      content: "Posted. I'll pass along replies.",
      origin: { kind: "slack", requester: { id: "U2", name: "alex", isOwner: false } },
      threadSequence: root.sequence,
    }),
  ]);
  expect(wakes.mock.calls).toEqual([
    [team.id, { systemMessage: { type: "team_message", senderName: "BryanBot" }, immediate: true }],
  ]);
});

test("a connector can start a conversation with a team, and continue it in that thread", async () => {
  const { teams, team, connector } = await open();
  await applyConnectorEvent(
    connector,
    event("Alex asked about the release", { to: { teamId: team.id } }),
  );
  await applyConnectorEvent(connector, event("Alex added: ship Friday"));

  const [first, second] = (await teams.listMessagesAfter(team.id)).filter(
    ({ sender }) => sender.type === "connector",
  );
  expect(first).toMatchObject({ content: "Alex asked about the release" });
  expect(first?.threadSequence).toBeUndefined();
  expect(second).toMatchObject({
    content: "Alex added: ship Friday",
    threadSequence: first!.sequence,
  });
});

test("a message carries its files to a connector, and names the ones it can't", async () => {
  const { connectors, team, connector } = await open();
  const directory = await mkdtemp(join(tmpdir(), "connector-files-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  const notes = join(directory, "notes.md");
  const clip = join(directory, "clip.webm");
  await Bun.write(notes, "# Notes");
  await Bun.write(clip, "webm");

  const fromAgent = await sendTeamMessageFromAgent(team.id, {
    content: "@bryanbot post these",
    attachmentPaths: [notes, clip],
  });
  await postTeamMessage({
    id: "upload",
    teamId: team.id,
    content: "@bryanbot and this screenshot",
    attachments: [{ mimeType: "image/png", base64: "iVBORw0KGgo=" }],
  });

  const sent = await queued(connectors, connector.id);
  expect(sent.find(({ id }) => id === fromAgent.id)).toMatchObject({
    content: "@bryanbot post these\n\n(Not forwarded: clip.webm, not a supported type)",
    attachments: [
      {
        name: "notes.md",
        mimeType: "text/markdown",
        base64: Buffer.from("# Notes").toString("base64"),
      },
    ],
  });
  expect(sent.find(({ id }) => id === "upload")).toMatchObject({
    content: "@bryanbot and this screenshot",
    attachments: [{ name: "image-1.png", mimeType: "image/png", base64: "iVBORw0KGgo=" }],
  });
});

test("a connector's files are saved once and attached to its team message by path", async () => {
  const { teams, team, connector } = await open();
  const home = await mkdtemp(join(tmpdir(), "connector-home-"));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  onTestFinished(async () => {
    Object.assign(process.env, previous);
    await rm(home, { recursive: true, force: true });
  });
  const shared = event("Dana shared the trace", {
    to: { teamId: team.id },
    attachments: [
      {
        name: "trace.md",
        mimeType: "text/markdown",
        base64: Buffer.from("# Trace").toString("base64"),
      },
      { name: "trace.md", mimeType: "text/plain", base64: Buffer.from("raw").toString("base64") },
    ],
  });

  await applyConnectorEvent(connector, shared);
  await applyConnectorEvent(connector, shared);

  const [message] = (await teams.listMessagesAfter(team.id)).filter(
    ({ sender }) => sender.type === "connector",
  );
  const directory = join(home, ".agent-teams", "connectors", connector.id, shared.id);
  expect(message).toMatchObject({
    content: "Dana shared the trace",
    attachments: [join(directory, "trace.md"), join(directory, "2-trace.md")],
  });
  expect(await Bun.file(join(directory, "trace.md")).text()).toBe("# Trace");
  expect(await Bun.file(join(directory, "2-trace.md")).text()).toBe("raw");
});

test("events for no current team are dropped, and connectors never forward to connectors", async () => {
  const { teams, connectors, team, connector } = await open();
  await applyConnectorEvent(connector, event("lost", { conversationId: "unknown" }));
  await applyConnectorEvent(connector, event("gone", { to: { teamId: "deleted-team" } }));
  await applyConnectorEvent(connector, event("@bryanbot echo", { to: { teamId: team.id } }));

  const fromConnector = (await teams.listMessagesAfter(team.id)).filter(
    ({ sender }) => sender.type === "connector",
  );
  expect(fromConnector.map(({ content }) => content)).toEqual(["@bryanbot echo"]);
  expect(await connectors.countPending(connector.id)).toBe(0);
});

test("a connector message never answers the lead's pending question", async () => {
  const { teams, team, connector } = await open();
  await sendTeamMessageFromAgent(team.id, { content: "Which channel?", request: true });
  const asked = (await teams.getTeam(team.id))!.requestSequence;
  expect(asked).not.toBeNull();

  await applyConnectorEvent(connector, event("Slack says hi", { to: { teamId: team.id } }));
  expect((await teams.getTeam(team.id))!.requestSequence).toBe(asked);
});

test("agents can't flood one conversation, but the user always gets through", async () => {
  const { teams, connectors, team, connector } = await open();
  const root = await postTeamMessage({ id: "root", teamId: team.id, content: "@bryanbot hi" });
  for (let index = 0; index < 21; index++) {
    await sendTeamMessageFromAgent(team.id, {
      content: `@bryanbot update ${index}`,
      threadSequence: root.sequence,
    });
  }
  await postTeamMessage({
    id: "user-again",
    teamId: team.id,
    content: "@bryanbot one more from me",
    threadSequence: root.sequence,
  });

  // One message is offered per conversation at a time, so count the whole outbox.
  expect(await connectors.countPending(connector.id)).toBe(1 + 20 + 1);
  expect((await teams.listMessagesAfter(team.id)).at(-2)).toMatchObject({
    content: {
      type: "connector_undelivered",
      reason: "throttled",
      threadSequence: root.sequence,
      excerpt: "@bryanbot update 20",
    },
  });
});

test("an undelivered message is noted in its team with the thread it belonged to", async () => {
  const { teams, connectors, team, connector } = await open();
  const root = await postTeamMessage({ id: "root", teamId: team.id, content: "@bryanbot hi" });
  const [sent] = await queued(connectors, connector.id);

  await noteUndeliveredConnectorMessage(connector, sent!, "expired");
  const note = (await teams.listMessagesAfter(team.id)).at(-1);
  expect(note).toMatchObject({
    sender: { type: "system" },
    content: {
      type: "connector_undelivered",
      connectorId: connector.id,
      threadSequence: root.sequence,
      reason: "expired",
      excerpt: "@bryanbot hi",
    },
  });
});

test("the directory lists every team a connector may address", async () => {
  await open();
  expect(await listConnectorDirectory()).toEqual([
    { id: expect.any(String), name: "Docs", purpose: "Ship the release notes." },
  ]);
});

test("agents read where each user and connector message came from", async () => {
  const { team, connector } = await open();
  await postTeamMessage({ id: "typed", teamId: team.id, content: "@bryanbot status?" });
  await applyConnectorEvent(
    connector,
    event("Owner said ship it", {
      to: { teamId: team.id },
      origin: { kind: "slack", requester: { id: "U1", name: "Bryan", isOwner: true } },
    }),
  );
  await applyConnectorEvent(
    connector,
    event("Alex asked about Friday", {
      conversationId: "conversation-2",
      to: { teamId: team.id },
      origin: { kind: "slack", requester: { id: "U2", name: "Alex", isOwner: false } },
    }),
  );
  await applyConnectorEvent(
    connector,
    event("Posted.", { conversationId: "conversation-3", to: { teamId: team.id } }),
  );

  const from = (await readTeam(team.id)).messages.map(({ from }) => from).filter(Boolean);
  expect(from).toEqual([
    "the user, in Agent Teams",
    "Bryan (the user) in Slack, via BryanBot",
    "Alex in Slack, via BryanBot",
    "BryanBot",
  ]);
});
