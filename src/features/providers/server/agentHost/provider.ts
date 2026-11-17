// A pool node's agent host as a session provider. Its sessions run in the host's Copilot agent,
// each in its own folder under the node's scratch folder, through the node's live connection.

import { ActionType, type ChatState, type RootState } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import {
  SessionConnectionUnavailableError,
  type SessionConfiguration,
  type SessionConnection,
  type SessionProvider,
} from "../provider";
import { activeClient, connectRemoteSession, defaultChat, sessionUri } from "./connection";
import { projectTurns, type NativeTurn } from "./projector";

const ROOT_CHANNEL = "ahp-root://";
/** Remote sessions run in the host's Copilot agent. */
const AGENT = "copilotcli";

/** A node's link to its agent host, which its provider runs sessions through. */
export type AgentHost = {
  readonly node: { readonly name: string; readonly scratchFolder: string };
  /** The connected host's client, or undefined while the node is out of reach. */
  readonly client: AhpClient | undefined;
  readonly clientId: string;
  readonly agents: RootState["agents"];
};

export function nodeProviderId(name: string): string {
  return `node:${name}`;
}

export function createNodeProvider(host: AgentHost): SessionProvider {
  const id = nodeProviderId(host.node.name);
  // Sessions with a live connection, whose subscriptions reading history or deleting must keep.
  const live = new Set<string>();

  function client(): AhpClient {
    if (!host.client) {
      throw new SessionConnectionUnavailableError(`The node ${host.node.name} is out of reach.`);
    }
    return host.client;
  }

  const agent = () => host.agents.find(({ provider }) => provider === AGENT);

  async function connect(
    sessionId: string,
    configuration: SessionConfiguration,
  ): Promise<SessionConnection> {
    const connection = await connectRemoteSession({
      providerId: id,
      client: client(),
      clientId: host.clientId,
      sessionId,
      models: agent()?.models.map(({ id }) => id) ?? [],
      configuration,
    });
    live.add(sessionId);
    return {
      ...connection,
      async disconnect() {
        live.delete(sessionId);
        await connection.disconnect();
      },
    };
  }

  async function release(remote: AhpClient, sessionId: string, ...channels: string[]) {
    if (live.has(sessionId)) return;
    await Promise.allSettled(channels.map((channel) => remote.unsubscribe(channel)));
  }

  return {
    id,
    name: host.node.name,
    async listModels() {
      return (agent()?.models ?? []).map((model) => ({
        id: model.id,
        name: model.name,
        provider: id,
      }));
    },
    async readSubscription() {
      return undefined;
    },
    async listSkills() {
      return [];
    },
    async listSessions() {
      return [];
    },
    async readHistory(session) {
      const remote = client();
      const sessionId = session.provider?.sessionId ?? session.id;
      const uri = sessionUri(sessionId);
      const chatUri = await defaultChat(remote, uri);
      try {
        let chat = await readChat(remote, chatUri);
        while (chat.turnsNextCursor) {
          await remote.request("fetchTurns", { channel: chatUri, cursor: chat.turnsNextCursor });
          chat = await readChat(remote, chatUri);
        }
        return projectTurns(chat.turns as unknown as NativeTurn[]);
      } finally {
        await release(remote, sessionId, chatUri, uri);
      }
    },
    async create(sessionId, configuration) {
      const remote = client();
      const uri = sessionUri(sessionId);
      // A retried create finds the session it already made instead of making another.
      const exists = await remote.request("subscribe", { channel: uri }).then(
        () => true,
        () => false,
      );
      if (!exists) {
        const provider = agent()?.provider ?? AGENT;
        const directory = fileUri(`${host.node.scratchFolder.replace(/[\\/]+$/, "")}/${sessionId}`);
        await remote.request("resourceMkdir", { channel: ROOT_CHANNEL, uri: directory });
        // Interactive mode keeps the model's own final answer, which reports to the owner;
        // autopilot appends a task summary after it. The host still holds risky native calls.
        const { values } = await remote.request("resolveSessionConfig", {
          channel: ROOT_CHANNEL,
          provider,
          workingDirectory: directory,
          config: { mode: "interactive", autoApprove: "default" },
        });
        await remote.request("createSession", {
          channel: uri,
          provider,
          config: values,
          workingDirectories: [directory],
          activeClient: activeClient(host.clientId, configuration.tools),
        });
      }
      return connect(sessionId, configuration);
    },
    resume: (session, configuration) =>
      connect(session.provider?.sessionId ?? session.id, configuration),
    async readDirectory() {
      return undefined;
    },
    async isHistoryCurrent() {
      return false;
    },
    async delete(nativeId) {
      const remote = client();
      const uri = sessionUri(nativeId);
      await remote.request("subscribe", { channel: uri });
      remote.dispatch(uri, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
      await release(remote, nativeId, uri);
    },
    async stop() {},
  };
}

async function readChat(client: AhpClient, chatUri: string): Promise<ChatState> {
  const { snapshot } = await client.request("subscribe", { channel: chatUri });
  return (snapshot?.state as ChatState | undefined) ?? ({ turns: [] } as unknown as ChatState);
}

/** A node's path as a file URI, whatever platform this server runs on. */
function fileUri(path: string): string {
  const slashed = path.replace(/\\/g, "/");
  return `file://${slashed.startsWith("/") ? "" : "/"}${encodeURI(slashed)}`;
}
