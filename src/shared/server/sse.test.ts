import { describe, expect, jest, spyOn, test } from "bun:test";
import { createSseResponse } from "./sse";

const BUDGET = 8 * 1024 * 1024;
const encoder = new TextEncoder();

describe("bounded SSE observation", () => {
  test("heartbeat/control frames share the byte budget and stop on overflow", async () => {
    jest.useFakeTimers();
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      let disposed = 0;
      const preludeBytes = encoder.encode("retry: 1000\n\n").byteLength;
      const frameOverhead = encoder.encode('data: ""\n\n').byteLength;
      const response = createSseResponse<string>(new Request("http://localhost"), (send) => {
        send("x".repeat(BUDGET - preludeBytes - frameOverhead));
        return () => disposed++;
      });
      await Promise.resolve();
      expect(disposed).toBe(0);
      jest.advanceTimersByTime(5_000);
      expect(disposed).toBe(1);
      await expect(response.body!.getReader().read()).rejects.toThrow("backlog");
      jest.advanceTimersByTime(10_000);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
      log.mockRestore();
    }
  });

  test("counts encoded Unicode frames and releases an overflowing observer", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const remove = spyOn(controller.signal, "removeEventListener");
    let send!: (value: string) => void;
    let disposed = 0;
    const response = createSseResponse<string>(
      new Request("http://localhost", { signal: controller.signal }),
      (push) => {
        send = push;
        return () => disposed++;
      },
    );
    await Promise.resolve();
    const frame = "\u{1f600}".repeat(1024);
    const bytes = encoder.encode(`data: ${JSON.stringify(frame)}\n\n`).byteLength;
    const count = Math.floor((BUDGET - encoder.encode("retry: 1000\n\n").byteLength) / bytes);
    for (let index = 0; index < count; index++) send(frame);
    expect(disposed).toBe(0);
    send(frame);
    expect(disposed).toBe(1);
    await expect(response.body!.getReader().read()).rejects.toThrow("backlog");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    expect(disposed).toBe(1);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  test("permits one oversized initial snapshot plus prelude, but nothing behind it", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    let send!: (value: string) => void;
    const large = "x".repeat(BUDGET + 1);
    const response = createSseResponse<string>(new Request("http://localhost"), (push) => {
      send = push;
      send(large);
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("retry: 1000\n\n");
    expect((await reader.read()).value!.byteLength).toBeGreaterThan(BUDGET);
    send(large);
    send("overflow");
    await expect(reader.read()).rejects.toThrow("backlog");
    log.mockRestore();
  });

  test("runs late async setup cleanup once after abort or cancel", async () => {
    for (const cancel of [false, true]) {
      const controller = new AbortController();
      let finish!: (cleanup: VoidFunction) => void;
      let disposed = 0;
      const response = createSseResponse(
        new Request("http://localhost", { signal: controller.signal }),
        () =>
          new Promise<VoidFunction>((resolve) => {
            finish = resolve;
          }),
      );
      if (cancel) await response.body!.cancel();
      else controller.abort();
      finish(() => disposed++);
      await Promise.resolve();
      await Promise.resolve();
      expect(disposed).toBe(1);
    }
  });

  test("request abort discards unread data rather than draining it", async () => {
    const controller = new AbortController();
    let disposed = 0;
    const response = createSseResponse(
      new Request("http://localhost", { signal: controller.signal }),
      (send) => {
        send("unread");
        return () => disposed++;
      },
    );
    await Promise.resolve();
    controller.abort(new Error("disconnected"));
    expect(disposed).toBe(1);
    await expect(response.body!.getReader().read()).rejects.toThrow("disconnected");
  });
});
