import { describe, expect, test } from "bun:test";
import type { Message, SessionEvent } from "./index";
import { applySessionEvent, createInitialSessionState } from "./reducer";
import {
  applySessionHistoryEvent,
  applySessionViewEvent,
  getSessionViewMessage,
  projectSessionHistory,
  projectSessionView,
  sessionHistoryStarts,
  SESSION_PAGE_SIZE,
} from "./view";
import { sessionHistoryInputSchema } from "./protocol";

function transcript(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `Message ${index}`,
  }));
}

describe("bounded session read projection", () => {
  test.each([0, 1, 49, 50, 51, 100, 5271])("recent window for %d canonical messages", (count) => {
    const state = createInitialSessionState({ messages: transcript(count), lastSeenEventId: 123 });
    const view = projectSessionView(state);
    expect(view.messageCount).toBe(count);
    expect(view.messages.length).toBe(Math.min(count, SESSION_PAGE_SIZE));
    expect(view.messageOffset).toBe(Math.max(0, count - SESSION_PAGE_SIZE));
    expect(view.messages).toEqual(state.messages.slice(view.messageOffset));
    expect(view.lastSeenEventId).toBe(123);
    expect(state.messages).toHaveLength(count);
  });

  test("random access pages have exact canonical boundaries, count and cursor", () => {
    const state = createInitialSessionState({ messages: transcript(5271), lastSeenEventId: 87 });
    for (const [start, offset, length] of [
      [0, 0, 50],
      [2500, 2500, 50],
      [5250, 5250, 21],
      [6000, 5271, 0],
    ]) {
      const page = projectSessionHistory(state, start);
      expect(page).toEqual({
        messageOffset: offset,
        messageCount: 5271,
        lastSeenEventId: 87,
        messages: state.messages.slice(offset, offset + length),
      });
    }
    expect(projectSessionHistory(createInitialSessionState(), 0).messages).toEqual([]);
    for (const start of [-1, 0.1, Infinity, NaN]) {
      expect(sessionHistoryInputSchema.safeParse({ sessionId: "test", start }).success).toBe(false);
    }
  });

  test("all outputs survive when the edits and last spoken text are outside the recent window", () => {
    const state = createInitialSessionState({
      messages: [
        { role: "user", content: `  ${"v".repeat(1200)}  ` },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "edit",
              name: "edit",
              arguments: { path: "old.txt", old_str: "old", new_str: "new\nline" },
              result: {
                success: true,
                content: "ok",
                details: "--- a/old.txt\n+++ b/old.txt\n@@ -1 +1,2 @@\n-old\n+new\n+line",
              },
            },
          ],
        },
        ...Array.from({ length: 60 }, (): Message => ({
          role: "system",
          content: { type: "channel_message", senderName: "Sender" },
        })),
      ],
      model: { provider: "test", name: "fake" },
      contextUsage: { tokens: 10, tokenWindow: 20 },
      todos: [{ id: "task", title: "Keep it", status: "done" }],
      linkedSessionIds: ["child"],
      artifacts: [{ path: "report.md", updatedAt: 123 }],
      canvases: [
        {
          key: "key",
          canvasId: "test",
          instanceId: "one",
          title: "Canvas",
          url: "http://localhost",
          revision: 1,
        },
      ],
      openedFiles: [{ kind: "machine", path: "old.txt" }],
      preview: { kind: "url", url: "http://localhost" },
      queuedMessages: [{ role: "user", clientId: "queued", content: "Next", status: "queued" }],
    });
    const view = projectSessionView(state, "C:\\repo");
    const { messages: _messages, ...metadata } = state;
    expect(view).toMatchObject(metadata);
    expect(view.messageCount).toBe(62);
    expect(view.lastVoiceMessage).toBe("v".repeat(1000));
    expect(view.editDiffs.total).toEqual({ added: 2, removed: 1 });
    expect(view.editDiffs.byToolCallId.get("edit")).toEqual({ added: 2, removed: 1 });
    expect(view.editDiffs.byFile).toHaveLength(1);
    expect(view.messages.some((message) => message.role === "assistant")).toBe(false);
  });

  test("thousands of live appends stay bounded and agree with the canonical reducer", () => {
    let canonical = createInitialSessionState({ messages: transcript(5271) });
    let view = projectSessionView(canonical);
    const events: SessionEvent[] = [];
    for (let index = 0; index < 600; index++) {
      events.push({ type: "user_message", content: `Prompt ${index}` });
      events.push({ type: "delta", content: `Answer ${index}`, messageId: `answer-${index}` });
    }
    for (const [index, event] of events.entries()) {
      const identified = { ...event, eventId: index + 1 };
      canonical = applySessionEvent(canonical, identified);
      view = applySessionViewEvent(view, identified);
      expect(view.messages.length).toBeLessThanOrEqual(50);
      expect(view.messageCount).toBe(canonical.messages.length);
      expect(view.messages).toEqual(canonical.messages.slice(-50));
    }
    expect(
      applySessionViewEvent(view, { type: "delta", content: "duplicate", eventId: 1 }).messages,
    ).toEqual(view.messages);
  });

  test("old visible tools/questions update directly without fabricating a history event", () => {
    const state = createInitialSessionState({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "old",
              name: "ask_user",
              arguments: {},
              question: {
                state: "pending",
                requestId: "request",
                question: "Which?",
                allowFreeform: true,
              },
            },
          ],
        },
        ...transcript(100),
      ],
      lastSeenEventId: 1,
    });
    const page = projectSessionHistory(state, 0);
    const event: SessionEvent = {
      type: "question_resolved",
      toolCallId: "old",
      answer: "Yes",
      eventId: 2,
    };
    const updated = applySessionHistoryEvent(page, event);
    const canonical = applySessionEvent(state, event);
    expect(updated.messages).toEqual(canonical.messages.slice(0, 50));
    expect(getSessionViewMessage(projectSessionView(canonical), [updated], 0)).toEqual(
      canonical.messages[0],
    );
    expect(applySessionHistoryEvent(updated, { ...event, answer: "stale", eventId: 1 })).toEqual(
      updated,
    );
    expect(
      applySessionHistoryEvent(updated, {
        type: "tool_start",
        toolCallId: "new",
        toolName: "read",
        arguments: {},
      }),
    ).toBe(updated);
  });

  test("old edit completions change the complete authoritative summary", () => {
    let state = createInitialSessionState({
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "old-edit",
              name: "edit",
              arguments: { path: "file", old_str: "a", new_str: "b\nc" },
            },
          ],
        },
        ...transcript(100),
      ],
    });
    expect(projectSessionView(state).editDiffs.total.added).toBe(0);
    state = applySessionEvent(state, {
      type: "tool_end",
      toolCallId: "old-edit",
      success: true,
      result: "ok",
      details: "--- a/file\n+++ b/file\n@@ -1 +1,2 @@\n-a\n+b\n+c",
    });
    expect(projectSessionView(state).editDiffs.total).toEqual({ added: 2, removed: 1 });
    state = applySessionEvent(state, { type: "tool_end", toolCallId: "old-edit", success: false });
    expect(projectSessionView(state).editDiffs.total).toEqual({ added: 0, removed: 0 });
  });

  test("viewport demand can jump directly anywhere without walking earlier pages", () => {
    expect(sessionHistoryStarts(0, 30, 5221, [])).toEqual([0]);
    expect(sessionHistoryStarts(2610, 2640, 5221, [])).toEqual([2600]);
    expect(sessionHistoryStarts(5200, 5270, 5221, [])).toEqual([5200]);
    expect(sessionHistoryStarts(5221, 5270, 5221, [])).toEqual([]);
    expect(sessionHistoryStarts(5250, 5270, 5221, [])).toEqual([]);
  });

  test("a sparse hidden-row viewport hydrates every rendered message beyond six raw pages", () => {
    const messages = Array.from({ length: 4000 }, (_, index): Message =>
      index % 50 === 0
        ? { role: "user", content: `Visible ${index}` }
        : { role: "assistant", content: "" },
    );
    const state = createInitialSessionState({ messages });
    const view = projectSessionView(state);
    for (const first of [0, 2000]) {
      const indices = Array.from({ length: 20 }, (_, index) => first + index * 50);
      const starts = sessionHistoryStarts(
        indices[0]!,
        indices.at(-1)!,
        view.messageOffset,
        view.hiddenMessageIndices,
      );
      expect(starts).toEqual(indices);
      const pages = starts.map((start) => projectSessionHistory(state, start));
      for (const index of indices) {
        expect(getSessionViewMessage(view, pages, index)).toEqual(messages[index]);
      }
      expect(pages).toHaveLength(indices.length);
    }
    expect(sessionHistoryStarts(1, 49, view.messageOffset, view.hiddenMessageIndices)).toEqual([]);
  });

  test("a legitimate giant individual message is never truncated", () => {
    const content = "x".repeat(2 * 1024 * 1024);
    expect(
      projectSessionView(createInitialSessionState({ messages: [{ role: "assistant", content }] }))
        .messages[0]?.content,
    ).toBe(content);
  });

  test("empty historical assistants are known without fetching their pages", () => {
    const messages: Message[] = Array.from({ length: 5271 }, () => ({
      role: "assistant",
      content: "",
    }));
    let view = projectSessionView(createInitialSessionState({ messages }));
    expect(view.hiddenMessageIndices).toHaveLength(5271);
    view = applySessionViewEvent(view, { type: "delta", content: "First visible text" });
    expect(view.hiddenMessageIndices).toHaveLength(5270);
    expect(view.hiddenMessageIndices.at(-1)).toBe(5269);
    expect(view.messageCount).toBe(5271);
    view = applySessionViewEvent(view, { type: "user_message", content: "Next prompt" });
    expect(view.hiddenMessageIndices).toHaveLength(5270);
  });
});
