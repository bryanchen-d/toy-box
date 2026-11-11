import { describe, expect, test } from "bun:test";
import {
  parsePorts,
  parseTunnels,
  tunnelEndpoint,
  withSilentLogin,
  type DevTunnelCli,
} from "./devtunnel";

const HOUR = 60 * 60_000;
const SHOW_OUTPUT = JSON.stringify({
  tunnel: {
    tunnelId: "bryanbot.usw2",
    ports: [{ portNumber: 4243, portUri: "https://x56sqjl5-4243.usw2.devtunnels.ms/" }],
  },
});

/** A fake CLI that issues numbered connect tokens expiring at the given times. */
function fakeCli(expirations: number[]) {
  const calls: string[][] = [];
  const cli: DevTunnelCli = async (args) => {
    calls.push(args);
    if (args[0] === "show") return SHOW_OUTPUT;
    const issued = calls.filter(([command]) => command === "token").length;
    const at = new Date(expirations[issued - 1]!).toISOString();
    return JSON.stringify({
      scope: "connect",
      expiration: `${at.slice(0, 10)} ${at.slice(11, 19)} UTC`,
      token: `token-${issued}`,
    });
  };
  return { cli, tokens: () => calls.filter(([command]) => command === "token").length };
}

describe("dev tunnel endpoint", () => {
  const transport = { type: "devtunnel" as const, tunnelId: "bryanbot.usw2", port: 4243 };

  test("reaches the port's HTTPS address with a connect token", async () => {
    const { cli } = fakeCli([Date.UTC(2026, 10, 12)]);
    const endpoint = await tunnelEndpoint(transport, cli, () => Date.UTC(2026, 10, 11));
    expect(endpoint.baseUrl).toBe("https://x56sqjl5-4243.usw2.devtunnels.ms/");
    expect(await endpoint.headers!()).toEqual({ "X-Tunnel-Authorization": "tunnel token-1" });
  });

  test("renews the token once, for every request, when it nears expiry", async () => {
    let now = Date.UTC(2026, 10, 11);
    const { cli, tokens } = fakeCli([now + 24 * HOUR, now + 48 * HOUR]);
    const endpoint = await tunnelEndpoint(transport, cli, () => now);
    now += 23.5 * HOUR;
    const headers = await Promise.all([endpoint.headers!(), endpoint.headers!()]);
    expect(headers.map((header) => header["X-Tunnel-Authorization"])).toEqual([
      "tunnel token-2",
      "tunnel token-2",
    ]);
    expect(tokens()).toBe(2);
  });

  test("a port the tunnel doesn't forward fails to open", async () => {
    const { cli } = fakeCli([Date.UTC(2026, 10, 12)]);
    await expect(tunnelEndpoint({ ...transport, port: 5000 }, cli)).rejects.toThrow(
      "doesn't forward port 5000",
    );
  });
});

describe("devtunnel login", () => {
  test("an expired login renews silently with the Windows sign-in, then the command retries", async () => {
    const calls: string[][] = [];
    let loggedIn = false;
    const cli = withSilentLogin(async (args) => {
      calls.push(args);
      if (args[0] === "user") {
        loggedIn = true;
        return "Logged in";
      }
      if (!loggedIn) throw new Error("devtunnel token failed: Login token expired.");
      return "ok";
    });
    expect(await cli(["token", "bryanbot"])).toBe("ok");
    expect(calls).toEqual([
      ["token", "bryanbot"],
      ["user", "login", "--entra", "--use-integrated-windows-auth"],
      ["token", "bryanbot"],
    ]);
  });

  test("other failures, and a login that can't renew silently, surface", async () => {
    await expect(
      withSilentLogin(async () => {
        throw new Error("devtunnel show failed: Tunnel not found.");
      })(["show", "x"]),
    ).rejects.toThrow("Tunnel not found");
    await expect(
      withSilentLogin(async () => {
        throw new Error("devtunnel token failed: Login token expired.");
      })(["token", "x"]),
    ).rejects.toThrow("Run `devtunnel user login` once");
  });
});

// Output captured from devtunnel CLI 1.0.2115.
const LIST_OUTPUT = `{
  "tunnels": [
    {
      "tunnelId": "sneaky-book-12dc72v.usw2",
      "name": "",
      "hostConnections": 1,
      "labels": ["brchen-db3", "protocolv6", "vscode-server-launcher", "_flag3"],
      "portCount": 2,
      "tunnelExpiration": "30 days",
      "description": ""
    },
    {
      "tunnelId": "bryanbot.usw2",
      "name": "",
      "hostConnections": 1,
      "labels": [],
      "portCount": 1,
      "tunnelExpiration": "30 days",
      "description": ""
    }
  ]
}`;

describe("devtunnel output", () => {
  test("reads each tunnel's ID, labels, and whether it is hosted", () => {
    expect(parseTunnels(LIST_OUTPUT)).toEqual([
      {
        tunnelId: "sneaky-book-12dc72v.usw2",
        labels: ["brchen-db3", "protocolv6", "vscode-server-launcher", "_flag3"],
        hostConnections: 1,
      },
      { tunnelId: "bryanbot.usw2", labels: [], hostConnections: 1 },
    ]);
  });

  test("reads a tunnel's port numbers", () => {
    expect(parsePorts(`{ "ports": [{ "portNumber": 4243, "protocol": "auto" }] }`)).toEqual([4243]);
    expect(parsePorts(`{ "ports": [] }`)).toEqual([]);
  });
});
