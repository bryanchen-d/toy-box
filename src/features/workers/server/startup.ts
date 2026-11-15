import { subscribeSessionCompletions } from "@sessions/server/runtime";
import { remindOwnersOfIdleSubSessions, reportToOwner, wakeDueSubSessions } from "./subSessions";
import { ensureWorkersSwept } from "./supervisor";

const TIMER_CHECK_MS = 30_000;

/**
 * Sweeps abandoned Workers, wakes each sub session's owner with every report it finishes, starts
 * each sub session's scheduled wake when it is due, and reminds owners of sub sessions left idle,
 * including any that fell due while the server was down.
 */
export default async function startWorkers(): Promise<VoidFunction> {
  const unsubscribe = subscribeSessionCompletions((sessionId, completion) => {
    reportToOwner(sessionId, completion).catch((error: unknown) =>
      console.error(`Could not report sub session ${sessionId} to its owner:`, error),
    );
  });
  const timers = setInterval(runDueTimers, TIMER_CHECK_MS);
  timers.unref?.();
  await ensureWorkersSwept().catch((error: unknown) =>
    console.error("Unable to sweep abandoned workers on startup:", error),
  );
  runDueTimers();
  return () => {
    unsubscribe();
    clearInterval(timers);
  };
}

function runDueTimers(): void {
  void wakeDueSubSessions()
    .then(() => remindOwnersOfIdleSubSessions())
    .catch((error: unknown) => console.error("Failed to run due sub-session timers:", error));
}
