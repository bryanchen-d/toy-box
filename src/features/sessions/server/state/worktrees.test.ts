import { beforeEach, describe, expect, mock, onTestFinished, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase } from "@/server/database";
import { agentTeamsDirectory } from "@/server/storage";
import type { SessionWorktree } from "@sessions/model";

let currentDb: Bun.SQL | undefined;
let gitCalls: Array<{ directory: string; args: string[] }> = [];
let runGit = async (_directory: string, _args: string[]): Promise<string> => {
  throw new Error("fatal: not a git repository (or any of the parent directories): .git");
};

mock.module("@/server/database", () => ({
  getStateDatabase: async (options?: { createIfMissing?: boolean }) => {
    if (!currentDb && options?.createIfMissing === false) return null;
    if (!currentDb) throw new Error("Test database has not been opened");
    return currentDb;
  },
}));

const {
  createSessionWorktree,
  deleteSessionWorktree,
  getAllSessionWorktrees,
  applySessionWorktree,
  mergeSessionWorktree,
} = await import("./worktrees");

async function openWorktreeTestDatabase(): Promise<void> {
  currentDb = await createTestDatabase();
  onTestFinished(async () => {
    await currentDb?.close();
    currentDb = undefined;
  });
}

async function insertWorktree(sessionId: string, worktree: SessionWorktree): Promise<void> {
  await currentDb!`
    INSERT INTO worktrees (
      session_id,
      worktree_path,
      worktree_branch,
      worktree_base_branch,
      lines_added,
      lines_removed
    )
    VALUES (
      ${sessionId},
      ${worktree.path},
      ${worktree.branch},
      ${worktree.baseBranch},
      ${worktree.linesAdded ?? null},
      ${worktree.linesRemoved ?? null}
    )
  `;
}

describe("session worktrees", () => {
  beforeEach(() => {
    gitCalls = [];
    runGit = async () => {
      throw new Error("fatal: not a git repository (or any of the parent directories): .git");
    };
    const execFile = spyOn(childProcess, "execFile").mockImplementation(((
      _file: string,
      command: string[],
      _options: { encoding: string },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const [, directory, ...args] = command;
      gitCalls.push({ directory: directory!, args });
      void runGit(directory!, args).then(
        (stdout) => callback(null, stdout, ""),
        (error: unknown) =>
          callback(error instanceof Error ? error : new Error(String(error)), "", ""),
      );
      return undefined as never;
    }) as unknown as typeof childProcess.execFile);
    onTestFinished(() => execFile.mockRestore());
  });

  test("creates the Git worktree and its record as one operation", async () => {
    await openWorktreeTestDatabase();
    runGit = async (_directory, args) => {
      if (args.join(" ") === "rev-parse --show-toplevel") return "/source";
      if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return "main";
      if (args[0] === "worktree" && args[1] === "add") return "";
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    };

    const sessionId = "11111111-1111-4111-8111-111111111111";
    const path = agentTeamsDirectory("worktrees", "11111111-111");
    await expect(createSessionWorktree(sessionId, "/source/subdirectory")).resolves.toEqual({
      path,
      branch: "agent-teams/11111111-111",
      baseBranch: "main",
    });
    expect(await getAllSessionWorktrees()).toEqual({
      [sessionId]: {
        path,
        branch: "agent-teams/11111111-111",
        baseBranch: "main",
        linesAdded: undefined,
        linesRemoved: undefined,
      },
    });
  });

  test("reads persisted worktree state", async () => {
    await openWorktreeTestDatabase();
    await insertWorktree("agent-teams-session", {
      path: "/tmp/agent-teams-session",
      branch: "agent-teams/session",
      baseBranch: "main",
      linesAdded: 12,
      linesRemoved: 3,
    });

    const expected = {
      path: "/tmp/agent-teams-session",
      branch: "agent-teams/session",
      baseBranch: "main",
      linesAdded: 12,
      linesRemoved: 3,
    };
    expect(await getAllSessionWorktrees()).toEqual({ "agent-teams-session": expected });
  });

  test("deletion releases the Git worktree before removing its record", async () => {
    await openWorktreeTestDatabase();
    await insertWorktree("agent-teams-session", {
      path: "/worktrees/session",
      branch: "agent-teams/session",
      baseBranch: "main",
    });
    runGit = async (_directory, args) => {
      if (args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") {
        return "/source/.git";
      }
      if (args[0] === "worktree" && args[1] === "remove") return "";
      if (args[0] === "branch" && args[1] === "-D") return "";
      throw new Error(`Unexpected Git command: ${args.join(" ")}`);
    };

    await deleteSessionWorktree("agent-teams-session");

    expect(gitCalls).toEqual([
      {
        directory: "/worktrees/session",
        args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      },
      {
        directory: "/source",
        args: ["worktree", "remove", "--force", "/worktrees/session"],
      },
      { directory: "/source", args: ["branch", "-D", "agent-teams/session"] },
    ]);
    expect(await getAllSessionWorktrees()).toEqual({});
  });

  test("deletion removes the record when the Git worktree is already gone", async () => {
    await openWorktreeTestDatabase();
    await insertWorktree("agent-teams-session", {
      path: `/tmp/agent-teams-missing-worktree-${crypto.randomUUID()}`,
      branch: "agent-teams/session",
      baseBranch: "main",
    });

    await deleteSessionWorktree("agent-teams-session");

    expect(await getAllSessionWorktrees()).toEqual({});
  });

  test("does not create a worktree outside a Git repository", async () => {
    const directory = `/tmp/agent-teams-missing-repository-${crypto.randomUUID()}`;
    expect(await createSessionWorktree("agent-teams-session", directory)).toBeUndefined();
  });

  test("read paths no-op when the server-state database does not exist", async () => {
    expect(await getAllSessionWorktrees()).toEqual({});
  });

  test("database requires complete worktree identity fields", async () => {
    await openWorktreeTestDatabase();

    let failure: unknown;
    try {
      await currentDb!`
        INSERT INTO worktrees (session_id)
        VALUES (${"agent-teams-session"})
      `;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
  });
});

for (const [name, finish] of [
  ["apply", applySessionWorktree],
  ["merge", mergeSessionWorktree],
] as const) {
  test(`${name} preserves unfinished edits, then transfers committed work to the source checkout`, async () => {
    await openWorktreeTestDatabase();
    const directory = await mkdtemp(join(tmpdir(), "agent-teams-worktree-test-"));
    onTestFinished(() => rm(directory, { recursive: true, force: true }));
    const source = join(directory, "source");
    const path = join(directory, "session");
    const git = async (cwd: string, ...args: string[]) => {
      const process = Bun.spawn(["git", "-C", cwd, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (code !== 0) throw new Error(stderr);
      return stdout.trim();
    };
    await git(directory, "init", "-b", "main", source);
    await git(source, "config", "user.name", "Agent Teams Test");
    await git(source, "config", "user.email", "test@example.invalid");
    await Bun.write(join(source, "value.txt"), "before\n");
    await git(source, "add", ".");
    await git(source, "commit", "-m", "fixture");
    await git(source, "worktree", "add", "-b", "session", path);
    await insertWorktree("agent-teams-session", { path, branch: "session", baseBranch: "main" });
    await Bun.write(join(path, "value.txt"), "after\n");
    await Bun.write(join(path, "new.txt"), "new file\n");

    await expect(finish("agent-teams-session")).rejects.toThrow("Commit the session's changes");
    expect(await Bun.file(join(source, "value.txt")).text()).toBe("before\n");
    expect(await Bun.file(join(path, "value.txt")).text()).toBe("after\n");
    expect(await Bun.file(join(path, "new.txt")).text()).toBe("new file\n");
    expect((await getAllSessionWorktrees())["agent-teams-session"]?.path).toBe(path);

    await git(path, "add", ".");
    await git(path, "commit", "-m", "session changes");
    await finish("agent-teams-session");
    expect(await Bun.file(join(source, "value.txt")).text()).toBe("after\n");
    expect(await Bun.file(join(source, "new.txt")).text()).toBe("new file\n");
    expect(await git(source, "branch", "--show-current")).toBe("main");
    expect(Boolean(await git(source, "status", "--porcelain"))).toBe(name === "apply");
    expect(
      await access(path).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await getAllSessionWorktrees()).toEqual({});
  });
}
