// One-off prompts answered through a short-lived native session with no tools. Copilot has no
// unsaved sessions, so each is deleted afterwards and kept out of the session catalog meanwhile.

import type { PermissionHandler } from "@github/copilot-sdk";
import type { ProviderPrompt } from "@providers/server/provider";
import { sharedSet } from "@/shared/server/processState";
import { startCopilotClient } from "./client";

const RESPONSE_TIMEOUT_MS = 60_000;

const oneOffSessions = sharedSet<string>("copilot-one-off-sessions");

const refuseAll: PermissionHandler = () => ({ kind: "reject" });

export async function respondOnce({
  model,
  instructions,
  prompt,
  signal,
}: ProviderPrompt): Promise<string> {
  signal?.throwIfAborted();
  const client = await startCopilotClient();
  const session = await client.createSession({
    model,
    availableTools: [],
    enableConfigDiscovery: false,
    systemMessage: { mode: "replace", content: instructions },
    onPermissionRequest: refuseAll,
  });
  oneOffSessions.add(session.sessionId);
  const abort = () => void session.abort().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return (await session.sendAndWait({ prompt }, RESPONSE_TIMEOUT_MS))?.data.content ?? "";
  } finally {
    signal?.removeEventListener("abort", abort);
    await session.disconnect().catch(console.error);
    await client.deleteSession(session.sessionId).catch(console.error);
    // A catalog read that started before deletion can still return it for a moment.
    setTimeout(() => oneOffSessions.delete(session.sessionId), RESPONSE_TIMEOUT_MS).unref();
  }
}

export function isOneOffSession(nativeId: string): boolean {
  return oneOffSessions.has(nativeId);
}
