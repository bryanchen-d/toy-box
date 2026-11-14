// Reaches a node's VS Code agent host: a WebSocket to the node's address, through its private dev
// tunnel when it has one, carrying the host's connection token. The protocol package's own
// WebSocket transport can't send the tunnel's authorization header, so the pool brings its own.
// Agent Teams stores no secrets for a node: it reads the token file and the owner's GitHub token
// from the gh CLI each time it connects.

import type { AhpTransport, TransportFrame } from "@microsoft/agent-host-protocol/client";
import type { PoolNode } from "../../model";
import { openConnectorEndpoint } from "../devtunnel";

const OPEN_TIMEOUT_MS = 30_000;

/** Opens an AHP transport to the node's agent host. */
export async function openNodeTransport(node: PoolNode): Promise<AhpTransport> {
  const endpoint = await openConnectorEndpoint(node.transport);
  const url = new URL(endpoint.baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("tkn", await readHostToken(node.tokenFile));
  // Bun's WebSocket takes request headers, which the DOM type doesn't declare.
  const socket = new WebSocket(url, { headers: await endpoint.headers?.() } as unknown as string[]);
  await opened(socket);
  return new WebSocketTransport(socket);
}

async function readHostToken(tokenFile: string): Promise<string> {
  const file = Bun.file(tokenFile);
  if (!(await file.exists())) throw new Error(`The host token file ${tokenFile} doesn't exist.`);
  const token = (await file.text()).trim();
  if (!token) throw new Error(`The host token file ${tokenFile} is empty.`);
  return token;
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

/** Frames in arrival order; a closed socket ends the stream. */
class WebSocketTransport implements AhpTransport {
  readonly #socket: WebSocket;
  readonly #frames: TransportFrame[] = [];
  readonly #waiters: ((frame: TransportFrame | null) => void)[] = [];
  #closed = false;

  constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const frame: TransportFrame = { kind: "text", text: String(event.data) };
      const waiter = this.#waiters.shift();
      if (waiter) waiter(frame);
      else this.#frames.push(frame);
    });
    socket.addEventListener("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
  }

  send(message: Parameters<AhpTransport["send"]>[0]): void {
    if (this.#closed) throw new Error("The agent host connection is closed.");
    this.#socket.send(typeof message === "string" ? message : JSON.stringify(message));
  }

  recv(): Promise<TransportFrame | null> {
    const frame = this.#frames.shift();
    if (frame) return Promise.resolve(frame);
    if (this.#closed) return Promise.resolve(null);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async close(): Promise<void> {
    this.#socket.close();
  }
}
