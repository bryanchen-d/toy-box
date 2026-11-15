import { subscribeSessionCompletions } from "@sessions/server/runtime";
import { reportToOwner, wakeDueSubSessions } from "./subSessions";
import { ensureWorkersSwept } from "./supervisor";

const WAKE_CHECK_MS = 30_000;

/**
 * Sweeps abandoned Workers, wakes each sub session's owner with every report it finishes, and
 * starts each sub session's scheduled wake when it is due, including ones that fell due while the
 * server was down.
 */
export default async function startWorkers(): Promise<VoidFunction> {
  const unsubscribe = subscribeSessionCompletions((sessionId, completion) => {
    reportToOwner(sessionId, completion).catch((error: unknown) =>
      console.error(`Could not report sub session ${sessionId} to its owner:`, error),
    );
  });
  const wakes = setInterval(() => void wakeDueSubSessions().catch(logWakeError), WAKE_CHECK_MS);
  wakes.unref?.();
  await ensureWorkersSwept().catch((error: unknown) =>
    console.error("Unable to sweep abandoned workers on startup:", error),
  );
  void wakeDueSubSessions().catch(logWakeError);
  return () => {
    unsubscribe();
    clearInterval(wakes);
  };
}

function logWakeError(error: unknown): void {
  console.error("Failed to wake due sub sessions:", error);
}
