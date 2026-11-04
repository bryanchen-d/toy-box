import { expect, test } from "bun:test";
import { channelMessageSearchInputSchema } from "./search";

test("channel search requires bounded literal text and an optional positive thread sequence", () => {
  expect(
    channelMessageSearchInputSchema.parse({ channelId: "channel", query: " needle " }),
  ).toEqual({
    channelId: "channel",
    query: "needle",
  });
  expect(
    channelMessageSearchInputSchema.parse({
      channelId: "channel",
      query: "needle",
      threadSequence: 4,
    }).threadSequence,
  ).toBe(4);
  for (const query of ["", " \n ", "x".repeat(501)]) {
    expect(channelMessageSearchInputSchema.safeParse({ channelId: "channel", query }).success).toBe(
      false,
    );
  }
  for (const threadSequence of [0, -1, 1.5, "4"]) {
    expect(
      channelMessageSearchInputSchema.safeParse({
        channelId: "channel",
        query: "needle",
        threadSequence,
      }).success,
    ).toBe(false);
  }
});
