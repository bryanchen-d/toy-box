// Reaches connectors behind a private dev tunnel at its port's HTTPS address, authorized by a
// short-lived connect token from the owner's `devtunnel` login. No token is stored and no local
// forwarding process runs.

import { z } from "zod";
import type { ConnectorTransport } from "../model";
import type { ConnectorEndpoint } from "./link";

/** VS Code's own Remote Tunnels share the account but never host a connector. */
const VSCODE_TUNNEL_LABEL = "vscode-server-launcher";

/** Connect tokens last a day; a fresh one is fetched once less than this remains. */
const TOKEN_RENEWAL_MS = 60 * 60_000;
const LOGIN_EXPIRED = /login token expired|not logged in|login required/i;

export type DevTunnel = { tunnelId: string; ports: number[]; hosted: boolean };

/** Runs one `devtunnel` command and returns its standard output. */
export type DevTunnelCli = (args: string[]) => Promise<string>;

export async function openConnectorEndpoint(
  transport: ConnectorTransport,
): Promise<ConnectorEndpoint> {
  return transport.type === "http" ? { baseUrl: transport.url } : tunnelEndpoint(transport);
}

/** The tunnel port's HTTPS address, with a connect token renewed before it expires. */
export async function tunnelEndpoint(
  { tunnelId, port }: Extract<ConnectorTransport, { type: "devtunnel" }>,
  cli: DevTunnelCli = devtunnel,
  now: () => number = Date.now,
): Promise<ConnectorEndpoint> {
  const { ports } = tunnelShowSchema.parse(
    JSON.parse(await cli(["show", tunnelId, "--json"])),
  ).tunnel;
  const portUri = ports.find(({ portNumber }) => portNumber === port)?.portUri;
  if (!portUri) throw new Error(`Dev tunnel ${tunnelId} doesn't forward port ${port}.`);
  const connectToken = async () =>
    parseToken(await cli(["token", tunnelId, "--scopes", "connect", "--json"]));
  let token = await connectToken();
  let renewal: Promise<typeof token> | undefined;
  return {
    baseUrl: portUri,
    async headers() {
      if (token.expiresAt - now() < TOKEN_RENEWAL_MS) {
        // Concurrent requests share one renewal; a failed one is retried by the next request.
        renewal ??= connectToken().finally(() => (renewal = undefined));
        token = await renewal;
      }
      return { "X-Tunnel-Authorization": `tunnel ${token.token}` };
    },
  };
}

/**
 * The logged-in account's tunnels that could host a connector, hosted ones first, with their
 * ports. VS Code's own Remote Tunnels are left out.
 */
export async function listConnectorTunnels(): Promise<DevTunnel[]> {
  const tunnels = parseTunnels(await devtunnel(["list", "--json"]));
  const candidates = await Promise.all(
    tunnels
      .filter(({ labels }) => !labels.includes(VSCODE_TUNNEL_LABEL))
      .map(async ({ tunnelId, hostConnections }) => ({
        tunnelId,
        ports: parsePorts(await devtunnel(["port", "list", tunnelId, "--json"])),
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

const tunnelShowSchema = z.object({
  tunnel: z.object({
    ports: z.array(z.object({ portNumber: z.number().int(), portUri: z.url() })).default([]),
  }),
});

const tokenSchema = z.object({
  token: z.string().min(1),
  // The CLI prints a UTC time such as "2026-11-12 02:42:11 UTC".
  expiration: z.string().transform((value, context) => {
    const at = Date.parse(value.replace(" ", "T").replace(/\s*UTC$/, "Z"));
    if (Number.isNaN(at)) context.addIssue({ code: "custom", message: `Bad expiration ${value}` });
    return at;
  }),
});

export function parseTunnels(output: string) {
  return tunnelListSchema.parse(JSON.parse(output)).tunnels;
}

export function parsePorts(output: string): number[] {
  return portListSchema.parse(JSON.parse(output)).ports.map(({ portNumber }) => portNumber);
}

function parseToken(output: string): { token: string; expiresAt: number } {
  const { token, expiration } = tokenSchema.parse(JSON.parse(output));
  return { token, expiresAt: expiration };
}

async function runDevTunnel(args: string[]): Promise<string> {
  const child = spawnDevTunnel(args);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // An expired login is reported on success too, without the requested output.
  if (code !== 0 || LOGIN_EXPIRED.test(stdout)) {
    throw new Error(`devtunnel ${args[0]} failed: ${(stderr || stdout).trim().slice(0, 300)}`);
  }
  return stdout;
}

/**
 * Renews an expired login once and retries. A Microsoft (Entra) login renews silently from the
 * machine's Windows sign-in; any other login needs its owner to sign in again.
 */
export function withSilentLogin(run: DevTunnelCli): DevTunnelCli {
  return async (args) => {
    try {
      return await run(args);
    } catch (error) {
      if (!(error instanceof Error) || !LOGIN_EXPIRED.test(error.message)) throw error;
      await run(["user", "login", "--entra", "--use-integrated-windows-auth"]).catch(() => {
        throw new Error(
          "The devtunnel login expired and couldn't renew silently. Run `devtunnel user login` once.",
        );
      });
      return run(args);
    }
  };
}

const devtunnel = withSilentLogin(runDevTunnel);

function spawnDevTunnel(args: string[]) {
  try {
    return Bun.spawn(["devtunnel", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    throw new Error("The devtunnel CLI isn't installed or isn't on PATH.", { cause: error });
  }
}
