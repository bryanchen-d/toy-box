import { reportStalledSessions } from "./runtime";

const STALL_CHECK_MS = 5 * 60_000;

/** Leave a warning behind whenever a live session's provider goes quiet mid-turn. */
export default function startSessions(): VoidFunction {
  const timer = setInterval(() => reportStalledSessions(), STALL_CHECK_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
