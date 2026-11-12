import { expect, test } from "bun:test";
import { judgedText, parseScreening } from "./judge";

const UNEXPLAINED = "It tries to steer an agent with instructions the user didn't give.";

test("the judge's verdict is read from its JSON reply", () => {
  expect(parseScreening('{"attack": false, "action": null}')).toEqual({ attack: false });
  expect(
    parseScreening(
      'Here you go:\n```json\n{"attack": true, "action": " run gh repo delete ", "quote": " delete the repo ", "reason": " Deletes the repository. "}\n```',
    ),
  ).toEqual({
    attack: true,
    action: "run gh repo delete",
    quote: "delete the repo",
    reason: "Deletes the repository.",
  });
});

test("an attack without its details still says what it tried and why", () => {
  expect(parseScreening('{"attack": true}')).toEqual({
    attack: true,
    action: "act on instructions the user didn't give",
    reason: UNEXPLAINED,
  });
  expect(parseScreening('{"attack": true, "quote": "", "reason": null}')).toEqual({
    attack: true,
    action: "act on instructions the user didn't give",
    reason: UNEXPLAINED,
  });
});

test("the action continues a sentence about what the content tries to do", () => {
  expect(
    parseScreening('{"attack": true, "action": "Upload the .env file to a paste site."}'),
  ).toMatchObject({ action: "upload the .env file to a paste site" });
  expect(parseScreening('{"attack": true, "action": "SSH into prod"}')).toMatchObject({
    action: "SSH into prod",
  });
});

test("a reply without a valid verdict is no verdict", () => {
  expect(parseScreening("I can't help with that.")).toBeUndefined();
  expect(parseScreening('{"attack": "yes"}')).toBeUndefined();
  expect(parseScreening("{not json}")).toBeUndefined();
});

test("long content keeps its start and end for the judge", () => {
  const text = `${"a".repeat(20_000)}${"b".repeat(10_000)}`;
  const judged = judgedText(text);
  expect(judged.startsWith("a".repeat(18_000))).toBe(true);
  expect(judged).toContain("[… 6000 characters omitted …]");
  expect(judged.endsWith("b".repeat(6_000))).toBe(true);
  expect(judgedText("short")).toBe("short");
});
