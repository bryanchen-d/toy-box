// A pool node's agent host as a session provider. Its sessions run in the host's Copilot agent,
// each in its own folder under the node's scratch folder, through the node's live connection.

import { ActionType, type ChatState } from "@microsoft/agent-host-protocol";
import type { AhpClient } from "@microsoft/agent-host-protocol/client";
import { nodeProviderId } from "@providers/model";
import { getProcessValue } from "@/shared/server/processState";
import {
  SessionConnectionUnavailableError,
  type SessionConfiguration,
  type SessionConnection,
  type SessionProvider,
} from "../provider";
import {
  activeClient,
  connectRemoteSession,
  defaultChat,
  sessionUri,
  type AgentHost,
} from "./connection";
import { projectTurns, type NativeTurn } from "./projector";

export type { AgentHost } from "./connection";

const ROOT_CHANNEL = "ahp-root://";
/** Remote sessions run in the host's Copilot agent. */
const AGENT = "copilotcli";

export function createNodeProvider(
  host: AgentHost,
  /** The node's current link, which replaces `host` when its pool changes or reloads. */
  currentHost: () => AgentHost | undefined = () => host,
): SessionProvider {
  const id = nodeProviderId(host.node.name);
  // Sessions with a live connection, whose subscriptions reading history or deleting must keep.
  const live = new Set<string>();
  // Sessions closed while the node was out of reach, retired once it connects. They outlive this
  // provider, which a changed pool replaces.
  const retiring = getProcessValue(`node-retirements:${id}`, () => new Set<string>());
  const stopRetiring = host.onConnected((client) => void retireClosed(client));
  if (host.client) void retireClosed(host.client);

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
      host,
      currentHost,
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

  /** Stops a closed session's run and archives it, so an old attempt never works beside a new one. */
  async function retire(remote: AhpClient, sessionId: string): Promise<void> {
    const uri = sessionUri(sessionId);
    const known = await remote.request("subscribe", { channel: uri }).then(
      () => true,
      () => false,
    );
    if (!known) return;
    const chatUri = await defaultChat(remote, uri);
    try {
      const { activeTurn } = await readChat(remote, chatUri);
      if (activeTurn) {
        remote.dispatch(chatUri, {
          type: ActionType.ChatTurnCancelled,
          turnId: activeTurn.id,
          duration: 0,
        });
      }
      remote.dispatch(uri, { type: ActionType.SessionIsArchivedChanged, isArchived: true });
    } finally {
      await release(remote, sessionId, chatUri, uri);
    }
  }

  async function retireClosed(remote: AhpClient): Promise<void> {
    for (const sessionId of [...retiring]) {
      try {
        await retire(remote, sessionId);
        retiring.delete(sessionId);
      } catch (error) {
        console.error(`Couldn't retire remote session ${sessionId} on ${host.node.name}:`, error);
      }
    }
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
      if (host.client) return retire(host.client, nativeId);
      retiring.add(nativeId);
    },
    async stop() {
      stopRetiring();
    },
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
