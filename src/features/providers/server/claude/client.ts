import {
  query,
  type Options,
  type Query,
  type SdkPluginConfig,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sharedSet } from "@/shared/server/processState";

const queries = sharedSet<Query>("claude-queries");

/** Claude only discovers `.claude/skills`, so the project's shared `.agents/skills` loads as a plugin. */
export function claudeSkillPlugins(
  directory: string | undefined,
  skillDirectories: readonly string[],
): SdkPluginConfig[] {
  const projectRoot = directory && join(directory, ".agents");
  const roots =
    projectRoot && existsSync(projectRoot) ? [...skillDirectories, projectRoot] : skillDirectories;
  return roots.map((path) => ({ type: "local", path }));
}

/** The SDK owns stdio and subprocess teardown; use the owner's installed CLI. */
export function startClaudeQuery(
  options: Options,
  prompt: AsyncIterable<SDKUserMessage> = new ReadableStream<SDKUserMessage>(),
): Query {
  const executable = Bun.which("claude");
  if (!executable)
    throw new Error("Install Claude Code and run `claude` to sign in, then refresh Toy Box.");
  const native = query({ prompt, options: { pathToClaudeCodeExecutable: executable, ...options } });
  queries.add(native);
  return native;
}

export async function closeClaudeQuery(native: Query): Promise<void> {
  queries.delete(native);
  await native.return();
}

export async function stopClaude(): Promise<void> {
  await Promise.all([...queries].map(closeClaudeQuery));
}
