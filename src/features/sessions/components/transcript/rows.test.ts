import { describe, expect, test } from "bun:test";
import type { Message } from "../../model";
import { createTranscriptRows } from "./rows";
import { createInitialSessionView } from "../../model/view";

function rowsFor(messages: Message[]) {
  const view = createInitialSessionView({ messages });
  const rows = createTranscriptRows(
    messages.length,
    (index) => messages[index],
    view.hiddenMessageIndices,
  );
  return Array.from({ length: rows.length }, (_, index) => rows.at(index));
}

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
    expect(rowsFor(messages)).toEqual([
      { key: "message-0", message: messages[0], messageIndex: 0 },
      { key: "message-2", message: messages[2], messageIndex: 2 },
      { key: "message-3", message: messages[3], messageIndex: 3 },
      { key: "message-4", message: messages[4], messageIndex: 4 },
      { key: "activity-4" },
    ]);
  });

  test("streaming text keeps its key while appends advance the activity key", () => {
    const before = rowsFor([{ role: "assistant", content: "Start" }]);
    const delta = rowsFor([{ role: "assistant", content: "Start of output" }]);
    expect(delta.map((row) => row.key)).toEqual(before.map((row) => row.key));
    const appended = rowsFor([
      { role: "assistant", content: "Start of output" },
      { role: "assistant", content: "Next" },
    ]);
    expect(appended[0].key).toBe(before[0].key);
    expect(appended.at(-1)?.key).not.toBe(before.at(-1)?.key);
  });

  test("keeps an activity host when every assistant is empty", () => {
    expect(rowsFor([{ role: "assistant", content: "" }])).toEqual([{ key: "activity-empty" }]);
  });

  test("preserves structured system messages", () => {
    const message: Message = {
      role: "system",
      content: { type: "channel_message", senderName: "Sender" },
    };
    expect(rowsFor([message])[0]).toEqual({
      key: "message-0",
      message,
      messageIndex: 0,
    });
  });

  test.each(["text", "tool"])(
    "advances activity identity when a hidden assistant gains %s without another message",
    (kind) => {
      const prompt: Message = { role: "user", content: "Prompt" };
      const pending = rowsFor([prompt, { role: "assistant", content: "" }]);
      const visible: Message =
        kind === "text"
          ? { role: "assistant", content: "Answer" }
          : {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "tool", name: "read", arguments: {} }],
            };
      const updated = rowsFor([prompt, visible]);
      expect(updated.at(-1)?.key).not.toBe(pending.at(-1)?.key);
    },
  );

  test("unloaded rows keep their canonical key when demand-loaded", () => {
    const unloaded = createTranscriptRows(5271, () => undefined, []);
    const loaded = createTranscriptRows(5271, () => ({ role: "assistant", content: "Loaded" }), []);
    expect(unloaded.at(2500).key).toBe(loaded.at(2500).key);
    expect(unloaded.length).toBe(5272);
  });
});
