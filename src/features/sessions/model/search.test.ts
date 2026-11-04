import { describe, expect, test } from "bun:test";
import type { Message } from "./index";
import { searchSessionMessages } from "./search";

describe("current-chat message search", () => {
  test("finds literal text case-insensitively, once per message, newest first", () => {
    const messages: Message[] = [
      { role: "user", content: "First NEEDLE and another needle" },
      { role: "assistant", content: "Unrelated" },
      { role: "assistant", content: "Latest needle" },
    ];
    expect(searchSessionMessages(messages, " needle ")).toEqual([
      { messageIndex: 2, role: "assistant", before: "Latest ", match: "needle", after: "" },
      {
        messageIndex: 0,
        role: "user",
        before: "First ",
        match: "NEEDLE",
        after: " and another needle",
      },
    ]);
  });

  test("returns at most 20 newest messages, including history outside the recent page", () => {
    const messages: Message[] = Array.from({ length: 200 }, (_, index) => ({
      role: "user",
      content: index < 70 ? `Needle ${index}` : "Recent unrelated message",
    }));
    expect(searchSessionMessages(messages, "needle").map((match) => match.messageIndex)).toEqual(
      Array.from({ length: 20 }, (_, index) => 69 - index),
    );
  });

  test("treats regex syntax as text and preserves original Unicode offsets", () => {
    expect(
      searchSessionMessages([{ role: "user", content: "İstanbul [a-z]+.*? $price" }], "[A-Z]+.*?"),
    ).toEqual([
      {
        messageIndex: 0,
        role: "user",
        before: "İstanbul ",
        match: "[a-z]+.*?",
        after: " $price",
      },
    ]);
    expect(searchSessionMessages([{ role: "user", content: "abc" }], ".*")).toEqual([]);
  });

  test("bounds snippets around the first match, not the beginning of a long message", () => {
    const matches = searchSessionMessages(
      [{ role: "assistant", content: "a".repeat(5000) + "Needle" + "b".repeat(5000) }],
      "needle",
    );
    expect(matches).toEqual([
      {
        messageIndex: 0,
        role: "assistant",
        before: "..." + "a".repeat(60),
        match: "Needle",
        after: "b".repeat(100) + "...",
      },
    ]);
  });

  test("searches visible system labels, but not hidden prompts or tool output", () => {
    expect(
      searchSessionMessages(
        [
          { role: "system", content: { type: "channel_message", senderName: "Needle" } },
          {
            role: "system",
            content: { type: "channel_routine", title: "Routine", prompt: "needle" },
          },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tool", name: "needle", arguments: { text: "needle" } }],
          },
        ],
        "needle",
      ),
    ).toEqual([
      { messageIndex: 0, role: "system", before: "Message from ", match: "Needle", after: "" },
    ]);
  });

  test("empty text, empty history, and absent text have no matches", () => {
    expect(searchSessionMessages([{ role: "user", content: "Hello" }], " \n ")).toEqual([]);
    expect(searchSessionMessages([], "hello")).toEqual([]);
    expect(searchSessionMessages([{ role: "assistant", content: "" }], "hello")).toEqual([]);
  });
});
