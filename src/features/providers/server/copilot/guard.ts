// Applies Agent Teams' tool guard through Copilot's session hooks. Pre-tool hooks may wait for
// the owner's approval; Copilot holds the call until they return.

import { basename } from "node:path";
import type { SessionHooks } from "@github/copilot-sdk";
import type { AgentAction } from "@security/model";
import type { SessionToolGuard } from "@providers/server/provider";
import { saveGeneratedImages } from "./generatedImages";

const SHELLS = new Set(["powershell", "bash", "shell"]);
// Copilot saves a result too large to show to a temp file before post-tool hooks run, so hooks
// see only a notice naming the file, and the agent reads the file later.
const SAVED_RESULT_NOTICE = /^Output too large to read at once \([^)]*\)\. Saved to: (.+)$/;
const SAVED_RESULT_FILE = /^\d+-copilot-tool-output-[\w-]+\.txt$/;
const FILE_WRITES = new Set(["edit", "create", "str_replace", "write"]);

/** Translate a native call. Copilot names MCP tools `<server>-<tool>`; its own never use hyphens. */
export function copilotAction(toolName: string, args: unknown): AgentAction {
  const input = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const text = (key: string) => (typeof input[key] === "string" ? input[key] : undefined);

  const command = SHELLS.has(toolName)
    ? text("command")
    : toolName === "write_powershell"
      ? text("input")
      : undefined;
  if (command) return { type: "command", command };
  if (toolName === "web_fetch" && text("url")) return { type: "fetch", url: text("url")! };
  if (toolName === "web_search" && text("query")) return { type: "search", query: text("query")! };
  if (FILE_WRITES.has(toolName) && text("path")) return { type: "write", paths: [text("path")!] };
  if (toolName === "apply_patch") {
    const patch = typeof args === "string" ? args : (text("patch") ?? text("input") ?? "");
    return {
      type: "write",
      paths: [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map(
        ([, path]) => path!.trim(),
      ),
    };
  }
  const separator = toolName.lastIndexOf("-");
  return separator > 0
    ? { type: "mcp", server: toolName.slice(0, separator), tool: toolName.slice(separator + 1) }
    : { type: "tool", name: toolName };
}

export function copilotGuardHooks(guard: SessionToolGuard): SessionHooks {
  return {
    async onPreToolUse({ toolName, toolArgs }) {
      const decision = await guard.review(copilotAction(toolName, toolArgs));
      if (!decision.allowed)
        return { permissionDecision: "deny", permissionDecisionReason: decision.reason };
    },
    async onPostToolUse(input, invocation) {
      const saved = await saveGeneratedImages(input, invocation);
      const result = input.toolResult.textResultForLlm;
      const screened = await guard.screen(
        copilotAction(input.toolName, input.toolArgs),
        result,
        await readSavedResult(result),
      );
      if (screened === result) return saved;
      return { ...saved, modifiedResult: { ...input.toolResult, textResultForLlm: screened } };
    },
  };
}

/** The full result Copilot saved in place of a result too large to show, if this is its notice. */
async function readSavedResult(result: string): Promise<string | undefined> {
  const path = SAVED_RESULT_NOTICE.exec(result.split("\n", 1)[0]!)?.[1]?.trim();
  // Only Copilot's own saved results, so a result can't name another file to read.
  if (!path || !SAVED_RESULT_FILE.test(basename(path))) return undefined;
  try {
    return await Bun.file(path).text();
  } catch {
    return undefined;
  }
}
