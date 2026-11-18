// Server console output, written by Nitro, H3, TanStack Start, and Agent Teams alike. Errors and
// warnings carry no time of their own, so each is stamped to match agent transcripts and provider
// logs. TanStack Start's bundled H3 reports a request its client abandoned as an unhandled 500
// that nobody receives; those reports are dropped.

import { getProcessValue } from "@/shared/server/processState";

const abandonedReasons = getProcessValue("abandoned-request-reasons", () => new WeakSet<object>());

/** Remember why a request was abandoned, so reports its abort causes can be recognized. */
export function noteAbandonedRequest(signal: AbortSignal): void {
  const note = () => {
    if (typeof signal.reason === "object" && signal.reason !== null) {
      abandonedReasons.add(signal.reason);
    }
  };
  if (signal.aborted) note();
  else signal.addEventListener("abort", note, { once: true });
}

/** What to write for one console report, or nothing when it only reports an abandoned request. */
export function serverConsoleLine(args: unknown[], now: Date): unknown[] | undefined {
  const [report] = args;
  if (report instanceof Error && isAbandonedReason(report.cause)) return undefined;
  return [`[${now.toISOString()}]`, ...args];
}

function isAbandonedReason(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && abandonedReasons.has(cause);
}
