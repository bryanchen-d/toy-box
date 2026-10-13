import { describe, expect, onTestFinished, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { workspaceQueries } from "@workspace/queries";
import {
  createEmptyWorkspaceState,
  type WorkspaceSessionStatus,
  type WorkspaceState,
} from "@workspace/model/state/reducer";
import { selectWorkspaceSessionActivity } from "./state";
import { sessionFile, workspaceFileId } from "@files/model";

describe("workspace query selectors", () => {
  test("projects one session without notifying it about another", () => {
    const queryClient = createQueryClient();
    seedWorkspace(queryClient, createEmptyWorkspaceState());
    const status = observe<WorkspaceSessionStatus>(
      queryClient,
      (workspace) => workspace.sessionStates["session-a"]?.status ?? "idle",
    );

    updateWorkspace(queryClient, (workspace) => ({
      ...workspace,
      sessionStates: { "session-b": { status: "running", since: 1 } },
    }));
    expect(status.data()).toBe("idle");
    expect(status.updates()).toBe(0);

    updateWorkspace(queryClient, (workspace) => ({
      ...workspace,
      sessionStates: {
        ...workspace.sessionStates,
        "session-a": { status: "running", since: 1 },
      },
    }));
    expect(status.data()).toBe("running");
    expect(status.updates()).toBe(1);
  });

  test("status and draft selectors ignore changes they do not expose", () => {
    const queryClient = createQueryClient();
    const draft = { text: "draft", origin: "client-a", updatedAt: 1 };
    const changedDraft = { text: "changed", origin: "client-a", updatedAt: 2 };
    seedWorkspace(queryClient, {
      ...createEmptyWorkspaceState(),
      drafts: { "session:session-a": draft },
    });
    const status = observe<WorkspaceSessionStatus>(
      queryClient,
      (workspace) => workspace.sessionStates["session-a"]?.status ?? "idle",
    );
    const selectedDraft = observe(
      queryClient,
      (workspace) => workspace.drafts["session:session-a"] ?? null,
    );

    updateWorkspace(queryClient, (workspace) => ({
      ...workspace,
      drafts: { "session:session-a": changedDraft },
    }));
    expect(status.updates()).toBe(0);
    expect(selectedDraft.updates()).toBe(1);
    const draftAfterEdit = selectedDraft.data();

    updateWorkspace(queryClient, (workspace) => ({
      ...workspace,
      sessionStates: { "session-a": { status: "running", since: 1 } },
    }));
    expect(status.updates()).toBe(1);
    expect(selectedDraft.data()).toBe(draftAfterEdit);
    expect(selectedDraft.updates()).toBe(1);
  });

  test("activity begins when a session starts running", () => {
    const queryClient = createQueryClient();
    seedWorkspace(queryClient, {
      ...createEmptyWorkspaceState(),
      sessionStates: {},
    });
    const activity = observe(queryClient, (workspace) =>
      selectWorkspaceSessionActivity(workspace, "session-a"),
    );

    expect(activity.data()).toEqual({
      running: false,
      waiting: false,
      unread: false,
      since: undefined,
      hasDraft: false,
    });
    expect(activity.updates()).toBe(0);

    updateWorkspace(queryClient, (workspace) => ({
      ...workspace,
      sessionStates: { "session-a": { status: "running", since: 1 } },
    }));
    expect(activity.data()).toEqual({
      running: true,
      waiting: false,
      unread: false,
      since: 1,
      hasDraft: false,
    });
    expect(activity.updates()).toBe(1);

    updateWorkspace(queryClient, (workspace) => ({
      ...workspace,
      sessionStates: { "session-a": { status: "waiting", since: 1 } },
    }));
    expect(activity.data()).toEqual({
      running: false,
      waiting: true,
      unread: false,
      since: 1,
      hasDraft: false,
    });
    expect(activity.updates()).toBe(2);
  });

  test("projects whether a session has a non-empty draft", () => {
    const queryClient = createQueryClient();
    seedWorkspace(queryClient, createEmptyWorkspaceState());
    const activity = observe(queryClient, (workspace) =>
      selectWorkspaceSessionActivity(workspace, "session-a"),
    );
    const draft = (text: string, updatedAt: number) => (workspace: WorkspaceState) => ({
      ...workspace,
      drafts: { "session:session-a": { text, origin: "client-a", updatedAt } },
    });

    updateWorkspace(queryClient, draft("   ", 1));
    expect(activity.data()?.hasDraft).toBe(false);
    expect(activity.updates()).toBe(0);

    updateWorkspace(queryClient, draft("Follow up", 2));
    expect(activity.data()?.hasDraft).toBe(true);
    expect(activity.updates()).toBe(1);

    updateWorkspace(queryClient, draft("Changed follow up", 3));
    expect(activity.data()?.hasDraft).toBe(true);
    expect(activity.updates()).toBe(1);

    updateWorkspace(queryClient, draft("", 4));
    expect(activity.data()?.hasDraft).toBe(false);
    expect(activity.updates()).toBe(2);
  });

  test("projects workers for only one artifact", () => {
    const queryClient = createQueryClient();
    const worker = {
      createdAt: new Date(0).toISOString(),
      type: "file" as const,
      sessionId: "artifact-worker-a",
      ephemeral: true,
      file: sessionFile("session-a", "plan.md"),
      name: "Respond to comment",
      metadata: { threadId: "thread-a" },
    };
    seedWorkspace(queryClient, {
      ...createEmptyWorkspaceState(),
      workers: [
        worker,
        {
          createdAt: new Date(0).toISOString(),
          type: "file",
          sessionId: "artifact-worker-b",
          ephemeral: true,
          file: sessionFile("session-a", "other.md"),
          metadata: { threadId: "thread-b" },
        },
      ],
    });
    const workers = observe(queryClient, (workspace) =>
      workspace.workers.filter(
        (candidate) =>
          candidate.type === "file" &&
          workspaceFileId(candidate.file) === workspaceFileId(sessionFile("session-a", "plan.md")),
      ),
    );
    expect(workers.data()).toEqual([worker]);

    updateWorkspace(queryClient, (workspace) => ({
      ...workspace,
      sessionStates: { "artifact-worker-a": { status: "running", since: 1 } },
    }));
    expect(workers.updates()).toBe(0);
  });
});

function createQueryClient(): QueryClient {
  const queryClient = new QueryClient();
  onTestFinished(() => queryClient.clear());
  return queryClient;
}

function seedWorkspace(queryClient: QueryClient, state: WorkspaceState): void {
  queryClient.setQueryData(workspaceQueries.stateKey(), state);
}

function updateWorkspace(
  queryClient: QueryClient,
  update: (workspace: WorkspaceState) => WorkspaceState,
): void {
  queryClient.setQueryData<WorkspaceState>(workspaceQueries.stateKey(), (workspace) =>
    update(workspace!),
  );
}

function observe<T>(queryClient: QueryClient, select: (workspace: WorkspaceState) => T) {
  const observer = new QueryObserver(queryClient, {
    ...workspaceQueries.state(),
    enabled: false,
    notifyOnChangeProps: ["data"],
    select,
  });
  let updateCount = 0;
  const unsubscribe = observer.subscribe(() => updateCount++);
  onTestFinished(unsubscribe);

  return {
    data: () => observer.getCurrentResult().data,
    updates: () => updateCount,
  };
}
