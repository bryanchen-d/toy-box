import { expect, test } from "bun:test";
import { sumSessionUsage } from "./usage";

test("sums fractional credits without treating missing reports as zero spend", () => {
  expect(
    sumSessionUsage([
      { aiCredits: 1.25, status: "complete" },
      { aiCredits: 2.5, status: "complete" },
    ]),
  ).toEqual({ aiCredits: 3.75, status: "complete" });
  expect(sumSessionUsage([{ aiCredits: 1.25, status: "complete" }, undefined])).toEqual({
    aiCredits: 1.25,
    status: "partial",
  });
  expect(
    sumSessionUsage([
      { aiCredits: 2, status: "partial" },
      { aiCredits: 0, status: "complete" },
    ]),
  ).toEqual({ aiCredits: 2, status: "partial" });
});

test("distinguishes an explicit free call from unavailable usage", () => {
  expect(sumSessionUsage([{ aiCredits: 0, status: "complete" }])).toEqual({
    aiCredits: 0,
    status: "complete",
  });
  for (const usages of [[], [undefined], [{ aiCredits: 0, status: "unavailable" as const }]]) {
    expect(sumSessionUsage(usages)).toEqual({ aiCredits: 0, status: "unavailable" });
  }
});
