// Applies Agent Teams' tool guard through Claude Agent SDK hooks. PreToolUse runs for every tool,
// including ones Claude would allow without asking, and may wait for the owner's approval.

import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { AgentAction } from "@security/model";
import type { SessionToolGuard } from "@providers/server/provider";

// An approval waits for a person, so the holding hook must outlast them.
const APPROVAL_TIMEOUT_SECONDS = 24 * 60 * 60;

const FILE_WRITES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Translate a native call. MCP tools are named `mcp__<server>__<tool>`. */
export function claudeAction(
  toolName: string,
  input: unknown,
  mcpServer?: { name: string },
): AgentAction {
  const args = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const text = (key: string) => (typeof args[key] === "string" ? args[key] : undefined);
  if ((toolName === "Bash" || toolName === "PowerShell") && text("command"))
    return { type: "command", command: text("command")! };
  if (toolName === "WebFetch" && text("url")) return { type: "fetch", url: text("url")! };
  if (toolName === "WebSearch" && text("query")) return { type: "search", query: text("query")! };
  if (FILE_WRITES.has(toolName)) {
    const path = text("file_path") ?? text("notebook_path");
    if (path) return { type: "write", paths: [path] };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) return { type: "mcp", server: mcpServer?.name ?? mcp[1]!, tool: mcp[2]! };
  return { type: "tool", name: toolName };
}

export function claudeGuardHooks(
  guard: SessionToolGuard,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        timeout: APPROVAL_TIMEOUT_SECONDS,
        hooks: [
          async (input, _toolUseId, { signal }) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const decision = await guard.review(
              claudeAction(input.tool_name, input.tool_input, input.mcp_server),
              signal,
            );
            return decision.allowed
              ? {}
              : {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: decision.reason,
                  },
                };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PostToolUse") return {};
            const output = toolOutputText(input.tool_response);
            const screened = await guard.screen(
              claudeAction(input.tool_name, input.tool_input, input.mcp_server),
              output.text,
            );
            return screened === output.text
              ? {}
              : {
                  hookSpecificOutput: {
                    hookEventName: "PostToolUse",
                    updatedToolOutput: output.replace(screened),
                  },
                };
          },
        ],
      },
    ],
  };
}

type ContentBlock = { type: string; text?: string };

/**
 * A tool result's text and how to put screened text back in its native shape. Claude ignores a
 * replacement whose shape it doesn't expect, so unknown shapes keep their original output.
 */
export function toolOutputText(response: unknown): {
  text: string;
  replace: (text: string) => unknown;
} {
  if (typeof response === "string") return { text: response, replace: (text) => text };
  const blocks = Array.isArray(response)
    ? (response as ContentBlock[])
    : response &&
        typeof response === "object" &&
        Array.isArray((response as { content?: unknown }).content)
      ? (response as { content: ContentBlock[] }).content
      : undefined;
  if (blocks) {
    const replaceBlocks = (text: string) => [
      { type: "text", text },
      ...blocks.filter((block) => block.type !== "text"),
    ];
    return {
      text: blocks.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n"),
      replace: Array.isArray(response)
        ? replaceBlocks
        : (text) => ({ ...(response as object), content: replaceBlocks(text) }),
    };
  }
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    const key = ["stdout", "result", "output"].find((name) => typeof record[name] === "string");
    if (key)
      return { text: record[key] as string, replace: (text) => ({ ...record, [key]: text }) };
  }
  return { text: JSON.stringify(response) ?? "", replace: (text) => text };
}
