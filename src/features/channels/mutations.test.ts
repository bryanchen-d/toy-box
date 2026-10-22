import { expect, onTestFinished, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { channelLead } from "./model";
import { channelQueries, type ChannelQueryData } from "./queries";
import { channelMutations } from "./mutations";

test.each([false, true])(
  "failed delivery preserves concurrent work and committed echoes (echoed=%s)",
  async (echoed) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    onTestFinished(() => client.clear());
    const state: ChannelQueryData = {
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
      artifacts: [],
      routines: [],
      presence: {},
      request: null,
      revision: 0,
      arrival: { id: 1, unreadAfter: null },
    };
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
