import { expect, test } from "bun:test";
import { sessionMessageSchema, sessionSearchInputSchema } from "./protocol";

test("a message can contain images without a prompt, but cannot attach documents", () => {
  const message = (mimeType: string) => ({
    content: "",
    attachments: [{ mimeType, base64: "aW1hZ2U=" }],
  });

  expect(sessionMessageSchema.safeParse(message("image/png")).success).toBe(true);
  for (const mimeType of ["text/plain", "application/pdf", "application/octet-stream"])
    expect(sessionMessageSchema.safeParse(message(mimeType)).success).toBe(false);
});

test("message search requires bounded nonblank text and normalizes surrounding whitespace", () => {
  expect(sessionSearchInputSchema.parse({ sessionId: "chat", query: " needle " })).toEqual({
    sessionId: "chat",
    query: "needle",
  });
  for (const query of ["", " \n ", "x".repeat(501)]) {
    expect(sessionSearchInputSchema.safeParse({ sessionId: "chat", query }).success).toBe(false);
  }
  expect(
    sessionSearchInputSchema.safeParse({ sessionId: "chat", query: "x".repeat(500) }).success,
  ).toBe(true);
});
