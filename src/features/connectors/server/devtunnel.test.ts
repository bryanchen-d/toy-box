import { describe, expect, test } from "bun:test";
import { parsePorts, parseTunnels } from "./devtunnel";

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
