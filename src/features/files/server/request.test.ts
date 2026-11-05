import { expect, test } from "bun:test";
import { resolveFileRequest } from "./request";

test("artifact requests reject a missing or out-of-sandbox path", async () => {
  const missing = await resolveFileRequest("agent-teams-session", undefined);
  const traversal = await resolveFileRequest("agent-teams-session", "../outside.md");

  expect("error" in missing && missing.error.status).toBe(400);
  expect("error" in traversal && traversal.error.status).toBe(403);
});
