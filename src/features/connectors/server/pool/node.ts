// One node's live connection to its agent host. It connects, signs the host's agents in with the
// owner's GitHub token, proves the connection alive with pings, and reconnects when it drops. The
// pool runs remote sessions through its client while it is connected.

import { SUPPORTED_PROTOCOL_VERSIONS, type RootState } from "@microsoft/agent-host-protocol";
import { AhpClient, type AhpTransport } from "@microsoft/agent-host-protocol/client";
import { backoffDelay, RECONNECT_BACKOFF, type ConnectorStatus, type PoolNode } from "../../model";

export const ROOT_CHANNEL = "ahp-root://";

export type NodeLinkDependencies = {
  /** Identifies this installation to the host, which keeps a client's tools across reconnects. */
  clientId: string;
  openTransport: (node: PoolNode) => Promise<AhpTransport>;
  githubToken: () => Promise<string>;
  onChange: () => void;
  now?: () => Date;
  timing?: Partial<typeof DEFAULT_TIMING>;
};

const DEFAULT_TIMING = {
  pingIntervalMs: 30_000,
  requestTimeoutMs: 60_000,
  /** Out of reach this long, a node needs someone to restore it rather than another retry. */
  unreachableAfterMs: 15 * 60_000,
  reconnectBackoff: RECONNECT_BACKOFF,
};

export class NodeLink {
  readonly node: PoolNode;
  readonly #deps: Required<Omit<NodeLinkDependencies, "timing">>;
  readonly #timing: typeof DEFAULT_TIMING;
  readonly #abort = new AbortController();
  #status: ConnectorStatus;
  #client: AhpClient | undefined;
  #failures = 0;
  #running: Promise<void> | undefined;
  #unreachableTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(node: PoolNode, dependencies: NodeLinkDependencies) {
    this.node = node;
    this.#deps = { ...dependencies, now: dependencies.now ?? (() => new Date()) };
    this.#timing = { ...DEFAULT_TIMING, ...dependencies.timing };
    this.#status = { state: "connecting", since: this.#deps.now().toISOString() };
  }

  get status(): ConnectorStatus {
    return this.#status;
  }

  /** The connected host's client, or undefined while the node is out of reach. */
  get client(): AhpClient | undefined {
    return this.#client;
  }

  start(): void {
    this.#running ??= this.#run();
    this.#watchReachability();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    clearTimeout(this.#unreachableTimer);
    await this.#client?.shutdown().catch(() => {});
    await this.#running;
  }

  async #run(): Promise<void> {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      try {
        await this.#connect(signal);
      } catch (error) {
        if (signal.aborted) break;
        this.#disconnected(error);
      }
      await sleep(backoffDelay(this.#failures, this.#timing.reconnectBackoff), signal);
    }
  }

  /** Holds one connection until it fails or the link stops. */
  async #connect(signal: AbortSignal): Promise<void> {
    const client = new AhpClient(await this.#deps.openTransport(this.node), {
      requestTimeoutMs: this.#timing.requestTimeoutMs,
    });
    client.connect();
    try {
      const { snapshots } = await client.initialize({
        clientId: this.#deps.clientId,
        protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        initialSubscriptions: [ROOT_CHANNEL],
      });
      const root = snapshots.find(({ resource }) => resource === ROOT_CHANNEL)?.state as
        | RootState
        | undefined;
      await this.#signIn(client, root);
      if (signal.aborted) return;
      this.#client = client;
      this.#connected();
      for (;;) {
        await sleep(this.#timing.pingIntervalMs, signal);
        if (signal.aborted) return;
        // A dropped connection rejects the ping, and the node reconnects.
        await client.ping();
      }
    } finally {
      this.#client = undefined;
      await client.shutdown().catch(() => {});
    }
  }

  /** Copilot on the host runs as the owner, signed in with their GitHub token. */
  async #signIn(client: AhpClient, root: RootState | undefined): Promise<void> {
    const resources = new Set(
      (root?.agents ?? []).flatMap((agent) =>
        (agent.protectedResources ?? []).map(({ resource }) => resource).filter(isGitHub),
      ),
    );
    if (resources.size === 0) return;
    const token = await this.#deps.githubToken();
    for (const resource of resources) {
      await client.request("authenticate", { channel: ROOT_CHANNEL, resource, token });
    }
  }

  #connected(): void {
    this.#failures = 0;
    clearTimeout(this.#unreachableTimer);
    this.#setStatus({ state: "connected", since: this.#deps.now().toISOString() });
  }

  #disconnected(error: unknown): void {
    this.#failures++;
    const status = this.#status;
    if (status.state !== "connected") {
      this.#setStatus({ ...status, error: errorMessage(error) });
      return;
    }
    this.#setStatus({
      state: "connecting",
      since: this.#deps.now().toISOString(),
      error: errorMessage(error),
    });
    this.#watchReachability();
  }

  #watchReachability(): void {
    clearTimeout(this.#unreachableTimer);
    this.#unreachableTimer = setTimeout(() => {
      const status = this.#status;
      if (status.state === "connecting") this.#setStatus({ ...status, state: "unreachable" });
    }, this.#timing.unreachableAfterMs);
    this.#unreachableTimer.unref?.();
  }

  #setStatus(status: ConnectorStatus): void {
    this.#status = status;
    this.#deps.onChange();
  }
}

function isGitHub(resource: string): boolean {
  try {
    const { hostname } = new URL(resource);
    return hostname === "github.com" || hostname.endsWith(".github.com");
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
