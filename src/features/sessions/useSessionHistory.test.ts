import { expect, test } from "bun:test";
import { createInitialSessionState } from "./model/reducer";
import { projectSessionHistory } from "./model/view";
import { readCurrentHistoryPage } from "./useSessionHistory";

test("a history read racing an old-tool update retries instead of overwriting newer rows", async () => {
  const stale = projectSessionHistory(createInitialSessionState({ lastSeenEventId: 1 }), 0);
  const fresh = { ...stale, lastSeenEventId: 3 };
  const pending = Promise.withResolvers<typeof stale>();
  let revision = { version: 0, eventId: 1 };
  let reads = 0;
  const result = readCurrentHistoryPage(
    () => (++reads === 1 ? pending.promise : Promise.resolve(fresh)),
    () => revision,
    new AbortController().signal,
  );
  revision = { version: 1, eventId: 2 };
  pending.resolve(stale);
  expect(await result).toBe(fresh);
  expect(reads).toBe(2);
});

test("a page already incorporating the raced event is adopted without an extra read", async () => {
  const page = projectSessionHistory(createInitialSessionState({ lastSeenEventId: 4 }), 0);
  let revision = { version: 0, eventId: 1 };
  const result = readCurrentHistoryPage(
    async () => page,
    () => revision,
    new AbortController().signal,
  );
  revision = { version: 1, eventId: 3 };
  expect(await result).toBe(page);
});

test("cancelled history reads never return resolved obsolete page data", async () => {
  const page = projectSessionHistory(createInitialSessionState(), 0);
  const controller = new AbortController();
  const pending = Promise.withResolvers<typeof page>();
  const result = readCurrentHistoryPage(
    () => pending.promise,
    () => ({ version: 0 }),
    controller.signal,
  );
  controller.abort(new Error("replaced"));
  pending.resolve(page);
  await expect(result).rejects.toThrow("replaced");
});

test.each(["historical-tool", "live-tail-tool"])(
  "pending reads fence only changes to their own rows: %s",
  async (toolCallId) => {
    const page = projectSessionHistory(
      createInitialSessionState({
        messages: [
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "historical-tool", name: "read", arguments: {} }],
          },
        ],
      }),
      0,
    );
    const changes = new Set<string | null>();
    let version = 0;
    let reads = 0;
    const result = await readCurrentHistoryPage(
      async () => {
        reads++;
        if (reads === 1) {
          version++;
          changes.add(toolCallId);
        }
        return page;
      },
      () => ({ version, changedToolCallIds: changes }),
      new AbortController().signal,
    );
    expect(result).toBe(page);
    expect(reads).toBe(toolCallId === "historical-tool" ? 2 : 1);
  },
);
