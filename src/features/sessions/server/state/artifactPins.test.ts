import { expect, onTestFinished, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "@/server/database";
import { SessionArtifactPinsDatabase } from "./artifactPins";

test("session pins persist in pin order, are idempotent and do not invent session identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "toy-box-artifact-pins-"));
  const path = join(directory, "state.sqlite");
  let db = await createTestDatabase(path);
  onTestFinished(async () => {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const pins = new SessionArtifactPinsDatabase(db);
  await pins.set("codex:native", "spec.md", true);
  await pins.set("codex:native", "plan.md", true);
  await pins.set("codex:native", "spec.md", true);
  await pins.set("other", "notes.md", true);
  expect(await pins.list("codex:native")).toEqual(["spec.md", "plan.md"]);
  expect(await db`SELECT session_id FROM sessions`).toEqual([]);
  await db.close();
  db = await createTestDatabase(path);
  const reopened = new SessionArtifactPinsDatabase(db);
  expect(await reopened.list("codex:native")).toEqual(["spec.md", "plan.md"]);
  await reopened.set("codex:native", "spec.md", false);
  await reopened.set("codex:native", "spec.md", true);
  expect(await reopened.list("codex:native")).toEqual(["plan.md", "spec.md"]);
  expect(await reopened.list("other")).toEqual(["notes.md"]);
});
