// Reaches connectors behind a private dev tunnel through the `devtunnel` CLI, which
// authenticates with the owner's cached login, so no access tokens are stored here.

import { z } from "zod";
import type { ConnectorTransport } from "../model";
import type { ConnectorEndpoint } from "./link";

/** VS Code's own Remote Tunnels share the account but never host a connector. */
const VSCODE_TUNNEL_LABEL = "vscode-server-launcher";

const READY_TIMEOUT_MS = 30_000;
const FORWARDING = /Forwarding from 127\.0\.0\.1:(\d+) to host port (\d+)/i;

export type DevTunnel = { tunnelId: string; ports: number[]; hosted: boolean };

export async function openConnectorEndpoint(
  transport: ConnectorTransport,
  signal: AbortSignal,
): Promise<ConnectorEndpoint> {
  return transport.type === "http"
    ? { baseUrl: transport.url, dispose: () => {} }
    : forwardDevTunnel(transport, signal);
}

/** Forwards the tunnel's port to this machine while the endpoint is held. */
async function forwardDevTunnel(
  { tunnelId, port }: Extract<ConnectorTransport, { type: "devtunnel" }>,
  signal: AbortSignal,
): Promise<ConnectorEndpoint> {
  const child = spawnDevTunnel(["connect", tunnelId]);
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const localPort = await new Promise<number>((resolve, reject) => {
      const output: string[] = [];
      const timer = setTimeout(
        () => reject(new Error(`devtunnel connect ${tunnelId} wasn't ready in 30 seconds.`)),
        READY_TIMEOUT_MS,
      );
      const onLine = (line: string) => {
        output.push(line);
        const match = FORWARDING.exec(line);
        if (match && Number(match[2]) === port) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      };
      void readLines(child.stdout, onLine);
      void readLines(child.stderr, onLine);
      void child.exited.then((code) => {
        clearTimeout(timer);
        const detail = output.filter(Boolean).slice(-3).join(" ");
        reject(
          new Error(
            `devtunnel connect ${tunnelId} exited (${code})${detail ? `: ${detail}` : "."}`,
          ),
        );
      });
    });
    return {
      baseUrl: `http://127.0.0.1:${localPort}`,
      dispose: () => {
        signal.removeEventListener("abort", stop);
        stop();
      },
    };
  } catch (error) {
    signal.removeEventListener("abort", stop);
    stop();
    throw error;
  }
}

/**
 * The logged-in account's tunnels that could host a connector, hosted ones first, with their
 * ports. VS Code's own Remote Tunnels are left out.
 */
export async function listConnectorTunnels(): Promise<DevTunnel[]> {
  const tunnels = parseTunnels(await runDevTunnel(["list", "--json"]));
  const candidates = await Promise.all(
    tunnels
      .filter(({ labels }) => !labels.includes(VSCODE_TUNNEL_LABEL))
      .map(async ({ tunnelId, hostConnections }) => ({
        tunnelId,
        ports: parsePorts(await runDevTunnel(["port", "list", tunnelId, "--json"])),
        hosted: hostConnections > 0,
      })),
  );
  return candidates.sort(
    (left, right) =>
      Number(right.hosted) - Number(left.hosted) || left.tunnelId.localeCompare(right.tunnelId),
  );
}

const tunnelListSchema = z.object({
  tunnels: z.array(
    z.object({
      tunnelId: z.string().min(1),
      labels: z.array(z.string()).default([]),
      hostConnections: z.number().default(0),
    }),
  ),
});

const portListSchema = z.object({
  ports: z.array(z.object({ portNumber: z.number().int().min(1).max(65_535) })),
});

export function parseTunnels(output: string) {
  return tunnelListSchema.parse(JSON.parse(output)).tunnels;
}

export function parsePorts(output: string): number[] {
  return portListSchema.parse(JSON.parse(output)).ports.map(({ portNumber }) => portNumber);
}

async function runDevTunnel(args: string[]): Promise<string> {
  const child = spawnDevTunnel(args);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`devtunnel ${args[0]} failed: ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  return stdout;
}

function spawnDevTunnel(args: string[]) {
  try {
    return Bun.spawn(["devtunnel", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error("The devtunnel CLI isn't installed or isn't on PATH.", { cause: error });
  }
}

async function readLines(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  onLine: (line: string) => void,
) {
  let buffered = "";
  try {
    for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";
      for (const line of lines) onLine(line);
    }
  } catch {
    // The process ended; its exit reports why.
  }
  if (buffered) onLine(buffered);
}
