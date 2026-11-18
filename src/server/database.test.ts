import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, inStateTransaction } from "./database";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("a transaction locked out by another connection reports where it waited", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-teams-database-"));
  directories.push(directory);
  const path = join(directory, "state.sqlite");
  const holder = await createTestDatabase(path);
  const contender = await createTestDatabase(path);
  const error = spyOn(console, "error").mockImplementation(() => {});
  let release!: () => void;
  const held = holder.begin("IMMEDIATE", () => new Promise<void>((resolve) => (release = resolve)));

  await expect(inStateTransaction(contender, async () => {})).rejects.toMatchObject({
    code: "SQLITE_BUSY",
  });

  expect(error).toHaveBeenCalledWith(
    expect.stringMatching(
      /^State database was locked at begin of a transaction at .+database\.test\.ts/,
    ),
  );
  error.mockRestore();
  release();
  await held;
  await Promise.all([holder.close(), contender.close()]);
});
