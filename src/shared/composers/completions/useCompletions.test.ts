import { describe, expect, test } from "bun:test";
import { matchCompletion, wordTrigger } from "./useCompletions";

describe("completion matching", () => {
  test("word triggers match after whitespace and replace the whole token", () => {
    expect(matchCompletion(wordTrigger("#"), "compare #src/fea", 16)).toEqual({
      start: 8,
      end: 16,
      query: "src/fea",
    });
    expect(matchCompletion(wordTrigger("@"), "@", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(matchCompletion(wordTrigger("@"), "use @composer next", 8)).toEqual({
      start: 4,
      end: 13,
      query: "com",
    });
    expect(matchCompletion(wordTrigger("#"), "open #notes.md please", 9)).toEqual({
      start: 5,
      end: 14,
      query: "not",
    });
  });

  test("word triggers ignore unrelated text, headings, URLs and encoded references", () => {
    for (const [trigger, value] of [
      ["#", "#notes.md and more"],
      ["#", "# Heading"],
      ["#", "url/#fragment"],
      ["@", "mail me@example.com"],
      ["@", "#plan"],
      ["#", "@plan"],
      ["@", "[Title](session:id)"],
      ["#", "[plan.md](file:src/plan.md)"],
    ])
      expect(matchCompletion(wordTrigger(trigger!), value!, value!.length)).toBeUndefined();
  });

  test("a token pattern's first capture is the query after its one-character trigger", () => {
    const trigger = /(?:^|\()\$([a-z]*)/;
    expect(matchCompletion(trigger, "total ($sum", 11)).toEqual({
      start: 7,
      end: 11,
      query: "sum",
    });
    expect(matchCompletion(trigger, "total $sum", 10)).toBeUndefined();
  });
});
