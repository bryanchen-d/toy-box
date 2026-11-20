import { reportStalledSessions } from "./runtime";

const STALL_CHECK_MS = 5 * 60_000;

/** Report each live session whose provider stalls mid-turn. */
export default function startSessions(): VoidFunction {
  const timer = setInterval(() => reportStalledSessions(), STALL_CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
