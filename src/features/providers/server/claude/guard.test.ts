import { expect, test } from "bun:test";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { SessionToolGuard } from "@providers/server/provider";
import { claudeAction, claudeGuardHooks, toolOutputText } from "./guard";

const base = { session_id: "native", transcript_path: "/t.jsonl", cwd: "/repo" };
const options = { signal: new AbortController().signal };

test("native calls translate into the actions the security policy reviews", () => {
  expect(claudeAction("Bash", { command: "git push" })).toEqual({
    type: "command",
    command: "git push",
  });
  expect(claudeAction("WebFetch", { url: "https://example.com", prompt: "x" })).toEqual({
    type: "fetch",
    url: "https://example.com",
  });
  expect(claudeAction("Write", { file_path: "/repo/CLAUDE.md" })).toEqual({
    type: "write",
    paths: ["/repo/CLAUDE.md"],
  });
  expect(claudeAction("mcp__github__issue_read", {})).toEqual({
    type: "mcp",
    server: "github",
    tool: "issue_read",
  });
  expect(claudeAction("mcp__gh__issue_read", {}, { name: "github" })).toMatchObject({
    server: "github",
  });
  expect(claudeAction("Read", { file_path: "a.ts" })).toEqual({ type: "tool", name: "Read" });
});

test("screened text goes back in each result's native shape", () => {
  expect(toolOutputText("plain").replace("x")).toBe("x");
  const bash = toolOutputText({ stdout: "out", stderr: "", interrupted: false });
  expect(bash.text).toBe("out");
  expect(bash.replace("x")).toEqual({ stdout: "x", stderr: "", interrupted: false });
  const mcp = toolOutputText([
    { type: "text", text: "a" },
    { type: "image", data: "AA" },
  ]);
  expect(mcp.text).toBe("a");
  expect(mcp.replace("x")).toEqual([
    { type: "text", text: "x" },
    { type: "image", data: "AA" },
  ]);
  expect(toolOutputText({ content: [{ type: "text", text: "b" }] }).replace("x")).toEqual({
    content: [{ type: "text", text: "x" }],
  });
  expect(toolOutputText({ results: [1] }).text).toBe('{"results":[1]}');
});

test("hooks deny refused calls and replace untrusted results", async () => {
  const guard: SessionToolGuard = {
    review: async (action) =>
      action.type === "command" ? { allowed: false, reason: "Blocked." } : { allowed: true },
    screen: async (action, result) => (action.type === "fetch" ? `[labeled] ${result}` : result),
  };
  const hooks = claudeGuardHooks(guard);
  const [pre] = hooks.PreToolUse![0]!.hooks;
  const [post] = hooks.PostToolUse![0]!.hooks;
  const call = (name: string, input: object) => ({
    ...base,
    tool_name: name,
    tool_input: input,
    tool_use_id: "use-1",
  });

  expect(
    await pre!(
      { ...call("Bash", { command: "git push" }), hook_event_name: "PreToolUse" } as HookInput,
      "use-1",
      options,
    ),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Blocked.",
    },
  });
  expect(
    await pre!(
      { ...call("Read", { file_path: "a" }), hook_event_name: "PreToolUse" } as HookInput,
      "use-1",
      options,
    ),
  ).toEqual({});
  expect(
    await post!(
      {
        ...call("WebFetch", { url: "https://example.com" }),
        hook_event_name: "PostToolUse",
        tool_response: { result: "page", code: 200 },
      } as HookInput,
      "use-1",
      options,
    ),
  ).toEqual({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { result: "[labeled] page", code: 200 },
    },
  });
});
