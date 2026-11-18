import { expect, test } from "bun:test";
import { noteAbandonedRequest, serverConsoleLine } from "./console";

const now = new Date("2026-11-18T21:45:00.000Z");

test("reports carry the time they were written", () => {
  const error = new Error("wake failed");
  expect(serverConsoleLine(["Failed to wake:", error], now)).toEqual([
    "[2026-11-18T21:45:00.000Z]",
    "Failed to wake:",
    error,
  ]);
});

test("only a report caused by an abandoned request's abort is dropped", () => {
  const abandoned = new AbortController();
  noteAbandonedRequest(new Request("http://localhost/", { signal: abandoned.signal }).signal);
  abandoned.abort();
  const unrelated = new AbortController();
  unrelated.abort();

  expect(serverConsoleLine([new Error("HTTPError", { cause: abandoned.signal.reason })], now)).toBe(
    undefined,
  );
  expect(
    serverConsoleLine([new Error("HTTPError", { cause: unrelated.signal.reason })], now),
  ).toHaveLength(2);
  expect(serverConsoleLine(["Stream stopped:", abandoned.signal.reason], now)).toHaveLength(3);
});
