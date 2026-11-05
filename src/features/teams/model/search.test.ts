import { expect, test } from "bun:test";
import { teamMessageSearchInputSchema } from "./search";

test("team search requires bounded literal text and an optional positive thread sequence", () => {
  expect(teamMessageSearchInputSchema.parse({ teamId: "team", query: " needle " })).toEqual({
    teamId: "team",
    query: "needle",
  });
  expect(
    teamMessageSearchInputSchema.parse({
      teamId: "team",
      query: "needle",
      threadSequence: 4,
    }).threadSequence,
  ).toBe(4);
  for (const query of ["", " \n ", "x".repeat(501)]) {
    expect(teamMessageSearchInputSchema.safeParse({ teamId: "team", query }).success).toBe(false);
  }
  for (const threadSequence of [0, -1, 1.5, "4"]) {
    expect(
      teamMessageSearchInputSchema.safeParse({
        teamId: "team",
        query: "needle",
        threadSequence,
      }).success,
    ).toBe(false);
  }
});
