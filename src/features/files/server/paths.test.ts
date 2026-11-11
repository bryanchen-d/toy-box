import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, onTestFinished, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { agentTeamsDirectory } from "@/server/storage";
import { listSessionArtifacts, deleteSessionFiles } from "@sessions/server/artifacts";
import {
  projectSessionArtifactPath,
  resolveSessionArtifactPath,
  resolveWorkspaceFile,
  workspaceFileFromAbsolutePath,
  sessionArtifactDirectory,
} from "./paths";

const sessionStatePath = (path: string) => agentTeamsDirectory("sessions", path);

describe("artifact paths", () => {
  test("relocated artifacts retain Session ownership and reject sibling directories", () => {
    const previous = process.env.AGENT_TEAMS_HOME;
    process.env.AGENT_TEAMS_HOME = join(tmpdir(), "agent-teams-relocated");
    onTestFinished(() => {
      if (previous === undefined) delete process.env.AGENT_TEAMS_HOME;
      else process.env.AGENT_TEAMS_HOME = previous;
    });
    const path = join(process.env.AGENT_TEAMS_HOME, "sessions", "example", "artifacts", "plan.md");
    expect(resolveSessionArtifactPath("example", "plan.md")).toBe(path);
    expect(workspaceFileFromAbsolutePath(path)).toEqual({
      kind: "session",
      sessionId: "example",
      path: "plan.md",
    });
    expect(projectSessionArtifactPath("example", path)).toBe("plan.md");
    expect(
      projectSessionArtifactPath("example", ".agent-teams/sessions/example/artifacts/plan.md"),
    ).toBe("plan.md");
    expect(
      projectSessionArtifactPath("example", "~/.agent-teams/sessions/example/artifacts/plan.md"),
    ).toBe("plan.md");
    expect(
      projectSessionArtifactPath("example", `${process.env.AGENT_TEAMS_HOME}-other/plan.md`),
    ).toBeUndefined();
  });
  test("owned artifacts and attachments share one deletion lifecycle", async () => {
    const id = `agent-teams-test-${crypto.randomUUID()}`;
    const directory = sessionArtifactDirectory(id)!;
    const attachments = resolve(directory, "../attachments/input.txt");
    onTestFinished(() => rm(resolve(directory, ".."), { recursive: true, force: true }));
    await mkdir(directory, { recursive: true });
    await Bun.write(resolve(directory, "report.md"), "Report");
    await Bun.write(attachments, "Input");
    expect(await Bun.file(resolveSessionArtifactPath(id, "report.md")!).text()).toBe("Report");
    expect(await listSessionArtifacts(id)).toEqual([
      { path: "report.md", updatedAt: expect.any(Number) },
    ]);
    await deleteSessionFiles(id);
    expect(await listSessionArtifacts(id)).toEqual([]);
    expect(await Bun.file(attachments).exists()).toBe(false);
  });
  describe("session artifacts", () => {
    test("resolves artifact-relative paths inside the session artifacts folder", () => {
      expect(resolveSessionArtifactPath("agent-teams-session", "report.md")).toBe(
        sessionStatePath("agent-teams-session/artifacts/report.md"),
      );
    });

    test("rejects paths outside the session artifacts folder", () => {
      expect(resolveSessionArtifactPath("agent-teams-session", "../workspace.yaml")).toBe(null);
      expect(resolveSessionArtifactPath("agent-teams-session", "/etc/passwd")).toBe(null);
      expect(
        resolveSessionArtifactPath(
          "agent-teams-session",
          "~/.agent-teams/sessions/other-session/artifacts/report.md",
        ),
      ).toBe(null);
    });

    test("rejects explicit filesystem-shaped artifact paths", () => {
      expect(
        resolveSessionArtifactPath(
          "agent-teams-session",
          "~/.agent-teams/sessions/agent-teams-session/artifacts/report.md",
        ),
      ).toBe(null);
      expect(
        resolveSessionArtifactPath(
          "agent-teams-session",
          ".agent-teams/sessions/agent-teams-session/artifacts/report.md",
        ),
      ).toBe(null);
    });

    test("rejects session IDs that escape the session state root", () => {
      expect(resolveSessionArtifactPath("../outside", "report.md")).toBe(null);
    });
  });

  describe("projected session artifact paths", () => {
    test("projects explicit SDK paths inside the same session artifacts folder", () => {
      expect(
        projectSessionArtifactPath(
          "agent-teams-session",
          sessionStatePath("agent-teams-session/artifacts/report.md"),
        ),
      ).toBe("report.md");
    });

    test("rejects root session-state files and other sessions", () => {
      expect(
        projectSessionArtifactPath(
          "agent-teams-session",
          sessionStatePath("agent-teams-session/report.md"),
        ),
      ).toBeUndefined();
      expect(
        projectSessionArtifactPath(
          "agent-teams-session",
          sessionStatePath("other-session/artifacts/report.md"),
        ),
      ).toBeUndefined();
    });

    test("rejects non-explicit working-directory relative paths", () => {
      expect(projectSessionArtifactPath("agent-teams-session", "files/report.md")).toBeUndefined();
      expect(projectSessionArtifactPath("agent-teams-session", "/tmp/report.md")).toBeUndefined();
    });
  });

  describe("workspace files", () => {
    test("classifies absolute Session artifacts without losing their owner", () => {
      expect(
        workspaceFileFromAbsolutePath(
          sessionStatePath("agent-teams-session/artifacts/nested/report.md"),
        ),
      ).toEqual({
        kind: "session",
        sessionId: "agent-teams-session",
        path: "nested/report.md",
      });
      expect(workspaceFileFromAbsolutePath("/repo/src/foo.ts")).toEqual({
        kind: "machine",
        path: resolve("/repo/src/foo.ts"),
      });
    });

    test("resolves a session file under its session artifacts folder", () => {
      expect(
        resolveWorkspaceFile({
          kind: "session",
          sessionId: "agent-teams-session",
          path: "report.md",
        }),
      ).toBe(sessionStatePath("agent-teams-session/artifacts/report.md"));
    });

    test("resolves a machine file to its own absolute path and rejects relative paths", () => {
      expect(resolveWorkspaceFile({ kind: "machine", path: "/repo/src/foo.ts" })).toBe(
        resolve("/repo/src/foo.ts"),
      );
      expect(resolveWorkspaceFile({ kind: "machine", path: "repo/src/foo.ts" })).toBeNull();
    });
  });
});
