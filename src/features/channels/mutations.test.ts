import { expect, onTestFinished, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { machineFile } from "@files/model";
import { channelLead, type ChannelArtifact } from "./model";
import { channelQueries, type ChannelQueryData } from "./queries";
import { channelMutations } from "./mutations";

function channelData(artifacts: ChannelArtifact[] = []): ChannelQueryData {
  return {
    channel: {
      id: "channel",
      name: "Canvas",
      model: { provider: "copilot", name: "gpt-5.5" },
      tasks: [],
      latestSequence: 0,
      seenThrough: 0,
      completedSequence: null,
      requestSequence: null,
      updatedAt: "2026-10-22T23:00:00.000Z",
    },
    lead: channelLead("channel"),
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
    const state = channelData();
    const key = channelQueries.detail("channel").queryKey;
    client.setQueryData(key, state);
    const task = { id: "verify", title: "Verify the result", status: "in_progress" as const };
    const failure = new Error("Delivery interrupted");
    const mutation = new MutationObserver(client, {
      ...channelMutations.post(),
      mutationFn: async () => {
        expect(client.getQueryData<ChannelQueryData>(key)?.messages).toMatchObject([
          { id: "request", content: "Request approval for item-1 at rev-a" },
        ]);
        client.setQueryData<ChannelQueryData>(
          key,
          (current) =>
            current && {
              ...current,
              revision: 1,
              channel: { ...current.channel, tasks: [task] },
              optimisticMessageIds: echoed ? [] : current.optimisticMessageIds,
            },
        );
        throw failure;
      },
    });
    await expect(
      mutation.mutate({
        id: "request",
        channelId: "channel",
        content: "Request approval for item-1 at rev-a",
      }),
    ).rejects.toBe(failure);
    expect(client.getQueryData<ChannelQueryData>(key)?.messages).toHaveLength(echoed ? 1 : 0);
    expect(client.getQueryData<ChannelQueryData>(key)?.channel.tasks).toEqual([task]);
    expect(client.getQueryData<ChannelQueryData>(key)?.optimisticMessageIds).toEqual([]);
    expect(mutation.getCurrentResult().error).toBe(failure);
  },
);

const artifact = (path: string): ChannelArtifact => ({
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
    const key = channelQueries.detail("channel").queryKey;
    const shared = [artifact("/plan.md"), artifact("/spec.md")];
    const newer = [artifact("/review.md"), ...shared];
    client.setQueryData(key, channelData(shared));
    const failure = new Error("Arrangement interrupted");
    const mutation = new MutationObserver(client, {
      ...channelMutations.arrangeArtifacts("channel"),
      mutationFn: async () => {
        // Arranging applies before the server confirms it.
        expect(client.getQueryData<ChannelQueryData>(key)?.artifacts).toEqual([
          shared[0]!,
          { ...shared[1]!, archived: true },
        ]);
        if (replaced) {
          client.setQueryData<ChannelQueryData>(
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
    expect(client.getQueryData<ChannelQueryData>(key)?.artifacts).toEqual(
      replaced ? newer : shared,
    );
  },
);
