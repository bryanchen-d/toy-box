import { describe, expect, jest, onTestFinished, spyOn, test } from "bun:test";
import * as state from "@/server/database";
import startScheduler from "./startup";

describe("automation scheduler lifetime", () => {
  test("polls every 30 seconds until cleanup, and cleanup is repeat-safe", () => {
    const readDatabase = setup();
    const stop = startScheduler();
    expect(stop).toBeFunction();
    expect(readDatabase).not.toHaveBeenCalled();

    jest.advanceTimersByTime(29_999);
    expect(readDatabase).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(readDatabase).toHaveBeenCalledTimes(1);
    expect(readDatabase).toHaveBeenLastCalledWith({ createIfMissing: false });
    jest.advanceTimersByTime(30_000);
    expect(readDatabase).toHaveBeenCalledTimes(2);

    stop();
    stop();
    jest.advanceTimersByTime(60_000);
    expect(readDatabase).toHaveBeenCalledTimes(2);
  });

  test("start-stop-start retains only the new startup's poller", () => {
    const readDatabase = setup();
    const stopFirst = startScheduler();
    expect(stopFirst).toBeFunction();
    jest.advanceTimersByTime(30_000);
    expect(readDatabase).toHaveBeenCalledTimes(1);

    stopFirst();
    jest.advanceTimersByTime(60_000);
    expect(readDatabase).toHaveBeenCalledTimes(1);

    const stopSecond = startScheduler();
    expect(stopSecond).toBeFunction();
    stopFirst();
    jest.advanceTimersByTime(29_999);
    expect(readDatabase).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(readDatabase).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(60_000);
    expect(readDatabase).toHaveBeenCalledTimes(4);

    stopSecond();
    jest.advanceTimersByTime(60_000);
    expect(readDatabase).toHaveBeenCalledTimes(4);
  });
});

function setup() {
  jest.useFakeTimers();
  const readDatabase = spyOn(state, "getStateDatabase").mockResolvedValue(null);
  onTestFinished(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    readDatabase.mockRestore();
  });
  return readDatabase;
}
