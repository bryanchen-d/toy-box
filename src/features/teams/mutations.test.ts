import { expect, onTestFinished, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { machineFile } from "@files/model";
import { teamLead, type TeamArtifact } from "./model";
import { teamQueries, type TeamQueryData } from "./queries";
import { teamMutations } from "./mutations";

function teamData(artifacts: TeamArtifact[] = []): TeamQueryData {
  return {
    team: {
      id: "team",
      name: "Canvas",
      paused: false,
      model: { provider: "copilot", name: "gpt-5.5" },
      tasks: [],
      latestSequence: 0,
      seenThrough: 0,
      completedSequence: null,
      requestSequence: null,
      updatedAt: "2026-10-22T23:00:00.000Z",
    },
    lead: teamLead("team"),
    members: [],
    messages: [],
    artifacts,
    routines: [],
    presence: {},
    request: null,
    revision: 0,
    arrival: { id: 1, unreadAfter: null },
  };
}

test.each([false, true])(
  "failed delivery preserves concurrent work and committed echoes (echoed=%s)",
  async (echoed) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    onTestFinished(() => client.clear());
    const state = teamData();
    const key = teamQueries.detail("team").queryKey;
    client.setQueryData(key, state);
    const task = { id: "verify", title: "Verify the result", status: "in_progress" as const };
    const failure = new Error("Delivery interrupted");
    const mutation = new MutationObserver(client, {
      ...teamMutations.post(),
      mutationFn: async () => {
        expect(client.getQueryData<TeamQueryData>(key)?.messages).toMatchObject([
          { id: "request", content: "Request approval for item-1 at rev-a" },
        ]);
        client.setQueryData<TeamQueryData>(
          key,
          (current) =>
            current && {
              ...current,
              revision: 1,
              team: { ...current.team, tasks: [task] },
              optimisticMessageIds: echoed ? [] : current.optimisticMessageIds,
            },
        );
        throw failure;
      },
    });
    await expect(
      mutation.mutate({
        id: "request",
        teamId: "team",
        content: "Request approval for item-1 at rev-a",
      }),
    ).rejects.toBe(failure);
    expect(client.getQueryData<TeamQueryData>(key)?.messages).toHaveLength(echoed ? 1 : 0);
    expect(client.getQueryData<TeamQueryData>(key)?.team.tasks).toEqual([task]);
    expect(client.getQueryData<TeamQueryData>(key)?.optimisticMessageIds).toEqual([]);
    expect(mutation.getCurrentResult().error).toBe(failure);
  },
);

const artifact = (path: string): TeamArtifact => ({
  id: `machine:${path}`,
  file: machineFile(path),
  title: path,
  sharedAt: "2026-10-22T23:00:00.000Z",
});

test.each([false, true])(
  "a failed arrangement undoes only itself (replaced=%s)",
  async (replaced) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    onTestFinished(() => client.clear());
    const key = teamQueries.detail("team").queryKey;
    const shared = [artifact("/plan.md"), artifact("/spec.md")];
    const newer = [artifact("/review.md"), ...shared];
    client.setQueryData(key, teamData(shared));
    const failure = new Error("Arrangement interrupted");
    const mutation = new MutationObserver(client, {
      ...teamMutations.arrangeArtifacts("team"),
      mutationFn: async () => {
        // Arranging applies before the server confirms it.
        expect(client.getQueryData<TeamQueryData>(key)?.artifacts).toEqual([
          shared[0]!,
          { ...shared[1]!, archived: true },
        ]);
        if (replaced) {
          client.setQueryData<TeamQueryData>(
            key,
            (current) => current && { ...current, revision: 1, artifacts: newer },
          );
        }
        throw failure;
      },
    });
    await expect(
      mutation.mutate({ artifactIds: ["machine:/spec.md"], archived: true }),
    ).rejects.toBe(failure);
    expect(client.getQueryData<TeamQueryData>(key)?.artifacts).toEqual(replaced ? newer : shared);
  },
);
