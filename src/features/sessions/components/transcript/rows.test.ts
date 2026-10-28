import { describe, expect, test } from "bun:test";
import type { Message } from "../../model";
import { createTranscriptRows } from "./rows";

describe("transcript rows", () => {
  test("omits empty assistants without losing absolute message identity", () => {
    const messages: Message[] = [
      { role: "user", content: "Prompt", clientId: "queued" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Answer" },
      { role: "assistant", content: "", error: "Failed" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "tool", name: "read", arguments: {} }],
      },
    ];
    expect(createTranscriptRows(messages)).toEqual([
      { key: "user-0", message: messages[0], messageIndex: 0 },
      { key: "assistant-2", message: messages[2], messageIndex: 2 },
      { key: "assistant-3", message: messages[3], messageIndex: 3 },
      { key: "assistant-4", message: messages[4], messageIndex: 4 },
      { key: "activity-assistant-4" },
    ]);
  });

  test("streaming text keeps its key while appends advance the activity key", () => {
    const before = createTranscriptRows([{ role: "assistant", content: "Start" }]);
    const delta = createTranscriptRows([{ role: "assistant", content: "Start of output" }]);
    expect(delta.map((row) => row.key)).toEqual(before.map((row) => row.key));
    const appended = createTranscriptRows([
      { role: "assistant", content: "Start of output" },
      { role: "assistant", content: "Next" },
    ]);
    expect(appended[0].key).toBe(before[0].key);
    expect(appended.at(-1)?.key).not.toBe(before.at(-1)?.key);
  });

  test("keeps an activity host when every assistant is empty", () => {
    expect(createTranscriptRows([{ role: "assistant", content: "" }])).toEqual([
      { key: "activity-empty" },
    ]);
  });

  test("preserves structured system messages", () => {
    const message: Message = {
      role: "system",
      content: { type: "channel_message", senderName: "Sender" },
    };
    expect(createTranscriptRows([message])[0]).toEqual({
      key: "system-0",
      message,
      messageIndex: 0,
    });
  });

  test.each(["text", "tool"])(
    "advances activity identity when a hidden assistant gains %s without another message",
    (kind) => {
      const prompt: Message = { role: "user", content: "Prompt" };
      const pending = createTranscriptRows([prompt, { role: "assistant", content: "" }]);
      const visible: Message =
        kind === "text"
          ? { role: "assistant", content: "Answer" }
          : {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "tool", name: "read", arguments: {} }],
            };
      const updated = createTranscriptRows([prompt, visible]);
      expect(updated.at(-1)?.key).not.toBe(pending.at(-1)?.key);
    },
  );
});
