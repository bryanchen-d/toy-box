import { describe, expect, test } from "bun:test";
import { chooseAgentHost } from "./transport";

const standalone = (instanceId: string) => ({ type: "standalone", instanceId });
const editor = { type: "editor", instanceId: "window" };

describe("choosing a node's agent host", () => {
  test("returns to the node's host while it is live", () => {
    expect(chooseAgentHost([standalone("new"), standalone("ours"), editor], "ours")).toEqual({
      instanceId: "ours",
    });
  });

  test("replaces a lost host with a new one, since a running host can't reopen its sessions", () => {
    expect(chooseAgentHost([standalone("other"), editor], "ours")).toEqual({ newDedicated: true });
  });

  test("without a host yet, takes a live standalone host, never an editor's", () => {
    expect(chooseAgentHost([editor, standalone("live")], undefined)).toEqual({
      instanceId: "live",
    });
    expect(chooseAgentHost([editor], undefined)).toEqual({ newDedicated: true });
  });
});
