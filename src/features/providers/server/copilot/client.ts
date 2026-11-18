// One Copilot SDK process, shared by every native session and catalog request.

import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { realpathSync } from "node:fs";
import { sharedMap, sharedWeakMap } from "@/shared/server/processState";

const copilotClients = sharedMap<Promise<CopilotClient>>("copilot-clients");
// Session registries outlive a dev server restart, but the SDK disconnects a stopped client's
// sessions without telling their handlers, so each connection learns of the stop here.
const clientLifetimes = sharedWeakMap<CopilotClient, AbortController>("copilot-client-lifetimes");

export async function stopCopilotClient(): Promise<void> {
  const client = copilotClients.get("shared");
  copilotClients.delete("shared");
  if (!client) return;
  const stopping = await client;
  lifetime(stopping).abort();
  await stopping.stop();
}

/** Aborts when this client stops; every session it served is unavailable from then on. */
export function copilotClientStopped(client: CopilotClient): AbortSignal {
  return lifetime(client).signal;
}

/** Start or reuse the one Copilot process shared by every server operation. */
export function startCopilotClient(): Promise<CopilotClient> {
  const existing = copilotClients.get("shared");
  if (existing) return existing;

  const promise = (async () => {
    const client = new CopilotClient({
      connection: RuntimeConnection.forStdio({ path: resolveCopilotCliPath() }),
      // Sessions releases idle connections for every provider; native expiry
      // would retire sessions the registry still holds.
      sessionIdleTimeoutSeconds: 0,
      // Make a compiled Bun executable behave like the Bun CLI when the SDK
      // uses process.execPath for child JavaScript entrypoints.
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
      },
    });
    await client.start();
    return client;
  })();
  copilotClients.set("shared", promise);
  void promise.catch(() => {
    if (copilotClients.get("shared") === promise) copilotClients.delete("shared");
  });
  return promise;
}

function lifetime(client: CopilotClient): AbortController {
  let controller = clientLifetimes.get(client);
  if (!controller) {
    controller = new AbortController();
    clientLifetimes.set(client, controller);
  }
  return controller;
}

/** Run the installed CLI, which Settings also reports and updates. */
function resolveCopilotCliPath(): string {
  try {
    const copilotBin = Bun.which("copilot");
    if (copilotBin) {
      try {
        return realpathSync(copilotBin);
      } catch {
        return copilotBin;
      }
    }
  } catch {
    // PATH lookup failed; report the actionable installation error below.
  }

  throw new Error(
    "Could not find `copilot` on PATH. Install it globally with `npm i -g @github/copilot`.",
  );
}
