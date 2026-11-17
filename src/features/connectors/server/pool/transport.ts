// Reaches a node's VS Code agent host through the machine's VS Code tunnel. The owner's GitHub
// token from the gh CLI finds the tunnel by machine name and gets a connect token from the Dev
// Tunnels service, and the tunnel's host-selection route picks one of the machine's live agent
// hosts and injects its connection token, so Agent Teams stores no secrets for a node. The
// protocol package's own WebSocket transport can't send the tunnel's authorization header, so the
// pool brings its own.

import type { AhpTransport, TransportFrame } from "@microsoft/agent-host-protocol/client";
import type { PoolNode } from "../../model";

const OPEN_TIMEOUT_MS = 30_000;
/** How long a node waits for a new dedicated agent host to start and answer. */
const NEW_HOST_TIMEOUT_MS = 120_000;
const TUNNELS_API = "https://global.rel.tunnels.api.visualstudio.com";
const TUNNELS_API_VERSION = "api-version=2023-09-27-preview";
/** The tunnel port `code tunnel` forwards to the machine's agent host. */
const AGENT_HOST_PORT = 31546;
const HOST_SELECTION_PATH = "/agent-host/select";

/**
 * Opens an AHP transport to the node's agent host, returning to `host` while it answers. The
 * gateway can list a host that has died, so one that doesn't answer is replaced by a new dedicated
 * host. If that one doesn't answer in time either, the newest other live host is taken rather than
 * starting more: the gateway lists the newest host first, and that is the slow new one once it
 * has started.
 */
export async function openNodeTransport(
  node: PoolNode,
  host: string | undefined,
): Promise<{ transport: AhpTransport; host: string }> {
  const tunnel = await findAgentHostTunnel(node.name, await githubToken());
  const open = (ask: string | undefined, exclude?: string) =>
    openAgentHost(tunnel.agentHostUrl, tunnel.connectToken, ask, exclude);
  if (!host) return open(undefined);
  for (const [ask, exclude] of [
    [host, undefined],
    [host, host],
  ] as const) {
    try {
      return await open(ask, exclude);
    } catch (error) {
      if (!(error instanceof HostSelectionError)) throw error;
    }
  }
  return open(undefined, host);
}

async function openAgentHost(
  agentHostUrl: string,
  connectToken: string,
  host: string | undefined,
  exclude: string | undefined,
): Promise<{ transport: AhpTransport; host: string }> {
  const url = new URL(HOST_SELECTION_PATH, agentHostUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  // Bun's WebSocket takes request headers, which the DOM type doesn't declare.
  const socket = new WebSocket(url, {
    headers: { "X-Tunnel-Authorization": `tunnel ${connectToken}` },
  } as unknown as string[]);
  // The host-selection route speaks first, so listen before the socket opens.
  const frames = new FrameBuffer(socket);
  await opened(socket);
  const selected = await selectAgentHost(socket, frames, host, exclude);
  return { transport: new WebSocketTransport(socket, frames), host: selected };
}

/** The owner's VS Code tunnel for a machine, found by the machine-name label `code tunnel` sets. */
async function findAgentHostTunnel(machine: string, token: string) {
  const headers = { Authorization: `github ${token}`, "User-Agent": "agent-teams" };
  const listing = (await tunnelsApi(
    `${TUNNELS_API}/tunnels?global=true&${TUNNELS_API_VERSION}`,
    headers,
  )) as {
    value?: { value?: { tunnelId: string; clusterId: string; labels?: string[] }[] }[];
  };
  const tunnel = (listing.value ?? [])
    .flatMap((region) => region.value ?? [])
    .find(({ labels = [] }) =>
      labels.some((label) => label.toLowerCase() === machine.toLowerCase()),
    );
  if (!tunnel) {
    throw new Error(
      `No VS Code tunnel named ${machine} is registered to your GitHub account. Start the VS Code Tunnel Host on that machine.`,
    );
  }
  const detail = (await tunnelsApi(
    `https://${tunnel.clusterId}.rel.tunnels.api.visualstudio.com/tunnels/${tunnel.tunnelId}?includePorts=true&tokenScopes=connect&${TUNNELS_API_VERSION}`,
    headers,
  )) as {
    accessTokens?: { connect?: string };
    ports?: { portNumber: number; portForwardingUris?: string[] }[];
  };
  const agentHostUrl = detail.ports?.find(({ portNumber }) => portNumber === AGENT_HOST_PORT)
    ?.portForwardingUris?.[0];
  const connectToken = detail.accessTokens?.connect;
  if (!agentHostUrl || !connectToken) {
    throw new Error(
      `${machine}'s VS Code tunnel doesn't forward its agent host; update its VS Code CLI.`,
    );
  }
  return { agentHostUrl, connectToken };
}

async function tunnelsApi(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`The Dev Tunnels service answered ${response.status} ${response.statusText}.`);
  }
  return response.json();
}

type HostInventory = {
  endpoints: { type: string; instanceId: string }[];
};

/**
 * The agent host a node's connection asks for. A remote session opens only on the host that has
 * it, and a host already running when another exits can't take that one's sessions over, while a
 * host started afterward can. So a node returns to its host while that is live and replaces a lost
 * one with a new dedicated host; a node with no host yet takes any live standalone host. Editor
 * hosts end with their window, so they're never chosen.
 */
export function chooseAgentHost(
  endpoints: HostInventory["endpoints"],
  host: string | undefined,
): { instanceId: string } | { newDedicated: true } {
  const standalone = endpoints.filter(({ type }) => type === "standalone");
  if (host) {
    return standalone.some(({ instanceId }) => instanceId === host)
      ? { instanceId: host }
      : { newDedicated: true };
  }
  return standalone[0] ? { instanceId: standalone[0].instanceId } : { newDedicated: true };
}

/** The chosen agent host didn't take the connection. */
class HostSelectionError extends Error {}

/** Selects the node's host, never `exclude`, which the gateway may still list after it died. */
async function selectAgentHost(
  socket: WebSocket,
  frames: FrameBuffer,
  host: string | undefined,
  exclude: string | undefined,
): Promise<string> {
  const inventory = JSON.parse(
    await frames.nextText("The tunnel didn't offer agent host selection; update its VS Code CLI."),
  ) as HostInventory;
  const choice = chooseAgentHost(
    inventory.endpoints.filter(({ instanceId }) => instanceId !== exclude),
    host,
  );
  socket.send(JSON.stringify(choice));
  // A new host takes a while to start.
  const timeoutMs = "newDedicated" in choice ? NEW_HOST_TIMEOUT_MS : OPEN_TIMEOUT_MS;
  try {
    const reply = JSON.parse(
      await frames.nextText(
        `The agent host didn't answer within ${timeoutMs / 1000} seconds.`,
        timeoutMs,
      ),
    ) as { ok: boolean; selected?: { instanceId: string }; error?: string };
    if (!reply.ok || !reply.selected) {
      throw new Error(`The agent host couldn't be selected: ${reply.error ?? "no reason given"}.`);
    }
    return reply.selected.instanceId;
  } catch (error) {
    socket.close();
    throw new HostSelectionError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
}

/** The owner's GitHub token, which signs a node's agent host in to Copilot. */
export async function githubToken(): Promise<string> {
  let child;
  try {
    child = Bun.spawn(["gh", "auth", "token"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error("The GitHub CLI isn't installed or isn't on PATH.", { cause: error });
  }
  const [token, detail, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 || !token.trim()) {
    throw new Error(
      `Couldn't read a GitHub token; run \`gh auth login\`. ${detail.trim().slice(0, 200)}`,
    );
  }
  return token.trim();
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("The agent host didn't answer within 30 seconds."));
    }, OPEN_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`Couldn't reach the agent host at ${socket.url.split("?")[0]}.`));
    });
  });
}

/** Frames in arrival order, buffered from before the socket opens; a closed socket ends them. */
class FrameBuffer {
  readonly #frames: TransportFrame[] = [];
  readonly #waiters: ((frame: TransportFrame | null) => void)[] = [];
  closed = false;

  constructor(socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const frame: TransportFrame = { kind: "text", text: String(event.data) };
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#frames.push(frame);
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
  }

  next(): Promise<TransportFrame | null> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** The next text frame, within a timeout, for the host-selection handshake. */
  async nextText(timeoutMessage: string, timeoutMs = OPEN_TIMEOUT_MS): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    try {
      const frame = await Promise.race([this.next(), timeout]);
      if (frame?.kind !== "text")
        throw new Error("The tunnel closed before an agent host was selected.");
      return frame.text;
    } finally {
      clearTimeout(timer);
    }
  }
}

class WebSocketTransport implements AhpTransport {
  readonly #socket: WebSocket;
  readonly #frames: FrameBuffer;

  constructor(socket: WebSocket, frames: FrameBuffer) {
    this.#socket = socket;
    this.#frames = frames;
  }

  send(message: Parameters<AhpTransport["send"]>[0]): void {
    if (this.#frames.closed) throw new Error("The agent host connection is closed.");
    this.#socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  recv(): Promise<TransportFrame | null> {
    return this.#frames.next();
  }

  async close(): Promise<void> {
    this.#socket.close();
  }
}
