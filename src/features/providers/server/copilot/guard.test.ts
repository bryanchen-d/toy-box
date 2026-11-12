import { expect, mock, onTestFinished, spyOn, test } from "bun:test";
import type { SessionHooks } from "@github/copilot-sdk";
import type { SessionToolGuard } from "@providers/server/provider";
import * as generatedImages from "./generatedImages";
import { copilotAction, copilotGuardHooks } from "./guard";

type PreToolUseHookInput = Parameters<NonNullable<SessionHooks["onPreToolUse"]>>[0];
type PostToolUseHookInput = Parameters<NonNullable<SessionHooks["onPostToolUse"]>>[0];

const base = { sessionId: "native", timestamp: new Date(), workingDirectory: "/repo" };

test("native calls translate into the actions the security policy reviews", () => {
  expect(copilotAction("powershell", { command: "git push" })).toEqual({
    type: "command",
    command: "git push",
  });
  expect(copilotAction("write_powershell", { shellId: "1", input: "y\n" })).toEqual({
    type: "command",
    command: "y\n",
  });
  expect(copilotAction("web_fetch", { url: "https://example.com" })).toEqual({
    type: "fetch",
    url: "https://example.com",
  });
  expect(copilotAction("web_search", { query: "bun" })).toEqual({ type: "search", query: "bun" });
  expect(copilotAction("edit", { path: "/repo/AGENTS.md" })).toEqual({
    type: "write",
    paths: ["/repo/AGENTS.md"],
  });
  expect(
    copilotAction(
      "apply_patch",
      "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n*** Add File: AGENTS.md\n*** End Patch",
    ),
  ).toEqual({ type: "write", paths: ["src/a.ts", "src/b.ts", "AGENTS.md"] });
  expect(copilotAction("github-mcp-server-issue_read", {})).toEqual({
    type: "mcp",
    server: "github-mcp-server",
    tool: "issue_read",
  });
  expect(copilotAction("read_team", {})).toEqual({ type: "tool", name: "read_team" });
});

test("a refused call is denied with its reason, and an allowed one proceeds unchanged", async () => {
  const review = mock<SessionToolGuard["review"]>(async (action) =>
    action.type === "command"
      ? { allowed: false, reason: "Agent Teams blocked this action." }
      : { allowed: true },
  );
  const hooks = copilotGuardHooks({ review, screen: async (_action, result) => result });
  const pre = (toolName: string, toolArgs: unknown) =>
    hooks.onPreToolUse!({ ...base, toolName, toolArgs } as PreToolUseHookInput, {
      sessionId: "native",
    });

  expect(await pre("powershell", { command: "git push" })).toEqual({
    permissionDecision: "deny",
    permissionDecisionReason: "Agent Teams blocked this action.",
  });
  expect(await pre("view", { path: "a.ts" })).toBeUndefined();
});

test("an untrusted result reaches the model screened; a trusted one is left alone", async () => {
  const hooks = copilotGuardHooks({
    review: async () => ({ allowed: true }),
    screen: async (action, result) => (action.type === "fetch" ? `[labeled] ${result}` : result),
  });
  const post = (toolName: string, toolArgs: unknown) =>
    hooks.onPostToolUse!(
      {
        ...base,
        toolName,
        toolArgs,
        toolResult: { textResultForLlm: "page text", resultType: "success" },
      } as PostToolUseHookInput,
      { sessionId: "native" },
    );

  expect(await post("web_fetch", { url: "https://example.com" })).toEqual({
    modifiedResult: { textResultForLlm: "[labeled] page text", resultType: "success" },
  });
  expect(await post("view", { path: "a.ts" })).toBeUndefined();
});

test("generated images are still saved and reported to the model", async () => {
  const saved = spyOn(generatedImages, "saveGeneratedImages").mockResolvedValue({
    additionalContext: "Saved the generated image to /images/a.png.",
  });
  onTestFinished(() => saved.mockRestore());
  const hooks = copilotGuardHooks({
    review: async () => ({ allowed: true }),
    screen: async (_action, result) => result,
  });

  expect(
    await hooks.onPostToolUse!(
      {
        ...base,
        toolName: "image_generation",
        toolArgs: {},
        toolResult: { textResultForLlm: "", resultType: "success" },
      } as PostToolUseHookInput,
      { sessionId: "native" },
    ),
  ).toEqual({ additionalContext: "Saved the generated image to /images/a.png." });
});
