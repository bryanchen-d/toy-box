import { subscribeSessionCompletions } from "@sessions/server/runtime";
import { subscribeWorkspaceEvents } from "@workspace/server/events";
import { getProcessValue } from "@/shared/server/processState";
import {
  noteWorking,
  remindOwnersOfIdleSubSessions,
  reportInterruptedSubSessions,
  reportToOwner,
  wakeDueSubSessions,
} from "./subSessions";
import { ensureWorkersSwept } from "./supervisor";

const TIMER_CHECK_MS = 30_000;

// A dev reload reruns startup without stopping the run it replaces, whose observers would
// otherwise report each finished execution once more per reload.
const running = getProcessValue("workers-startup", () => ({
  stop: undefined as VoidFunction | undefined,
}));

/**
 * Sweeps abandoned Workers, wakes each sub session's owner with every report it finishes, starts
 * each sub session's scheduled wake when it is due, and reminds owners of sub sessions left idle,
 * including any that fell due while the server was down. Each sub session's runs are noted as
 * they start and stop, so a run the server's last stop interrupted is reported to its owner.
 */
export default async function startWorkers(): Promise<VoidFunction> {
  running.stop?.();
  const unsubscribe = subscribeSessionCompletions((sessionId, completion) => {
    reportToOwner(sessionId, completion).catch((error: unknown) =>
      console.error(`Could not report sub session ${sessionId} to its owner:`, error),
    );
  });
  const unsubscribeRuns = subscribeWorkspaceEvents((event) => {
    switch (event.type) {
      case "session.running":
      case "session.waiting":
      case "session.background":
      case "session.idle":
      case "session.unread":
        noteWorking(
          event.sessionId,
          event.type !== "session.idle" && event.type !== "session.unread",
        ).catch((error: unknown) =>
          console.error(`Could not note sub session ${event.sessionId}'s run:`, error),
        );
    }
  });
  const timers = setInterval(runDueTimers, TIMER_CHECK_MS);
  timers.unref?.();
  const stop = () => {
    unsubscribe();
    unsubscribeRuns();
    clearInterval(timers);
    if (running.stop === stop) running.stop = undefined;
  };
  running.stop = stop;
  await ensureWorkersSwept().catch((error: unknown) =>
    console.error("Unable to sweep abandoned workers on startup:", error),
  );
  await reportInterruptedSubSessions().catch((error: unknown) =>
    console.error("Unable to report interrupted sub sessions on startup:", error),
  );
  runDueTimers();
  return stop;
}

function runDueTimers(): void {
  void wakeDueSubSessions()
    .then(() => remindOwnersOfIdleSubSessions())
    .catch((error: unknown) => console.error("Failed to run due sub-session timers:", error));
}
