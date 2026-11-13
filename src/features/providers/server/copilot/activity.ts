// Copilot native history as the timestamped canonical events that determine session activity.
// History files can reach gigabytes, so lines stream and only lifecycle and usage lines are parsed.
// Native idle events are ephemeral, so work ends where a native turn ended and the next one waited
// for input or a notification; an abort, error, or process boundary also ends it.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { SessionEvent } from "@sessions/model";
import { createCopilotUsageProjector, type CopilotEvent } from "./usage";

type NativeEvent = CopilotEvent & { timestamp: string; agentId?: string };
type TimedEvent = { at: number; event: SessionEvent };

// Quotes inside JSON strings are escaped, so transcript content cannot match.
const ACTIVITY_LINE =
  /"type":"(?:assistant\.turn_(?:start|end)|user\.message|system\.notification|abort|session\.(?:start|resume|shutdown|error|usage_record|usage_checkpoint))"/;

/** Stream a native `events.jsonl` as the events, at their native times, that determine activity. */
export async function* readCopilotActivity(path: string): AsyncGenerator<TimedEvent> {
  const projectUsage = createCopilotUsageProjector();
  let working = false;
  // When the latest native turn ended, while the next one may still continue the same work.
  let turnEnded: number | undefined;
  let lastAt = 0;
  const stop = (at: number): TimedEvent => {
    working = false;
    turnEnded = undefined;
    return { at, event: { type: "status", status: "idle" } };
  };

  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!ACTIVITY_LINE.test(line)) continue;
    const event = JSON.parse(line) as NativeEvent;
    const at = Date.parse(event.timestamp);
    lastAt = at;
    for (const usage of projectUsage(event) ?? []) yield { at, event: usage };
    if (event.agentId) continue;
    switch (event.type) {
      case "assistant.turn_start":
        if (!working) {
          working = true;
          yield { at, event: { type: "status", status: "thinking" } };
        }
        turnEnded = undefined;
        break;
      case "assistant.turn_end":
        if (working) turnEnded = at;
        break;
      case "user.message":
      case "system.notification":
        if (turnEnded !== undefined && !isModelContext(event)) yield stop(turnEnded);
        break;
      case "abort":
      case "session.start":
      case "session.resume":
      case "session.shutdown":
      case "session.error":
        if (working) yield stop(turnEnded ?? at);
        break;
    }
  }
  if (working) yield stop(turnEnded ?? lastAt);
}

/** Skill loads and system reminders inform the model within a turn; they are not new input. */
function isModelContext(event: NativeEvent): boolean {
  return (
    event.type === "user.message" &&
    (event.data.source?.startsWith("skill-") === true || event.data.source === "system")
  );
}
