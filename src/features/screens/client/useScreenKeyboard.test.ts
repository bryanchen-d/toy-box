import { describe, expect, test } from "bun:test";
import { TEXTAREA_ANCHOR, typedInput } from "./useScreenKeyboard";

describe("typing into the keyboard textarea", () => {
  test.each(["hello", " ", "\u4f60\u597d", "\u{1f642}"])(
    "sends %s as text, without the anchor",
    (text) => {
      expect(typedInput("insertText", TEXTAREA_ANCHOR + text)).toEqual([{ type: "text", text }]);
    },
  );

  test.each([
    ["deleteContentBackward", "Backspace"],
    ["deleteContentForward", "Delete"],
    ["insertLineBreak", "Enter"],
    ["insertParagraph", "Enter"],
  ])("sends %s as a key press rather than text", (inputType, code) => {
    expect(typedInput(inputType, TEXTAREA_ANCHOR)).toEqual([
      { type: "key", code, down: true },
      { type: "key", code, down: false },
    ]);
  });

  test("keeps replacement text whose selection included the anchor", () => {
    expect(typedInput("insertReplacementText", "replacement")).toEqual([
      { type: "text", text: "replacement" },
    ]);
  });

  test("sends nothing for an empty or cancelled composition", () => {
    expect(typedInput("insertFromComposition", TEXTAREA_ANCHOR)).toEqual([]);
    expect(typedInput("insertFromComposition", "")).toEqual([]);
  });
});
