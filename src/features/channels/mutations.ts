import { mutationOptions } from "@tanstack/react-query";
import {
  applyChannelArtifactArrangement,
  type ArrangeChannelArtifactsInput,
  type CreateChannelMemberInput,
  type CreateChannelInput,
  type EditChannelInput,
  type PostChannelMessageInput,
  type UpdateChannelMemberInput,
} from "@channels/model";
import { channelQueries, type ChannelQueryData } from "@channels/queries";
import { reduceChannelState } from "@channels/model/reducer";
import { applyChannelListEvent, invalidateChannelListQuery } from "@channels/queryCache";
import {
  arrangeChannelArtifacts,
  createChannel,
  createChannelMember,
  deleteChannel,
  deleteChannelRoutine,
  editChannel,
  markChannelRead,
  postChannelMessage,
  removeChannelMember,
  runChannelRoutine,
  updateChannelMember,
} from "@channels/server/functions";

export const channelMutations = {
  create: () =>
    mutationOptions({
      mutationFn: (input: CreateChannelInput) => createChannel({ data: input }),
      onSuccess: (_channel, _input, _result, { client }) => invalidateChannelListQuery(client),
    }),
  createMember: () =>
    mutationOptions({
      mutationFn: (input: CreateChannelMemberInput) => createChannelMember({ data: input }),
    }),
  updateMember: () =>
    mutationOptions({
      mutationFn: (input: UpdateChannelMemberInput) => updateChannelMember({ data: input }),
    }),
  edit: () =>
    mutationOptions({
      mutationFn: (input: EditChannelInput) => editChannel({ data: input }),
      onSuccess: (_channel, _input, _result, { client }) => invalidateChannelListQuery(client),
    }),
  delete: (channelId: string) =>
    mutationOptions({
      mutationFn: () => deleteChannel({ data: { channelId } }),
      onSuccess: (_deleted, _variables, _result, { client }) => {
        applyChannelListEvent(client, { type: "channel.deleted", channelId });
      },
    }),
  removeMember: (agentId: string) =>
    mutationOptions({
      mutationFn: () => removeChannelMember({ data: { agentId } }),
    }),
  runRoutine: (channelId: string) =>
    mutationOptions({
      mutationFn: (routineId: string) => runChannelRoutine({ data: { channelId, routineId } }),
    }),
  deleteRoutine: (channelId: string) =>
    mutationOptions({
      mutationFn: (routineId: string) => deleteChannelRoutine({ data: { channelId, routineId } }),
    }),
  /** Arranges at once; the committed `artifacts` event then confirms or corrects it. */
  arrangeArtifacts: (channelId: string) => {
    const key = channelQueries.detail(channelId).queryKey;
    return mutationOptions({
      mutationFn: (arrangement: Omit<ArrangeChannelArtifactsInput, "channelId">) =>
        arrangeChannelArtifacts({ data: { channelId, ...arrangement } }),
      onMutate: (arrangement, { client }) => {
        const previous = client.getQueryData<ChannelQueryData | null>(key)?.artifacts;
        if (!previous) return undefined;
        const arranged = applyChannelArtifactArrangement(previous, arrangement);
        client.setQueryData<ChannelQueryData | null>(
          key,
          (state) => state && { ...state, artifacts: arranged },
        );
        // Structural sharing stores its own copy, which identifies this arrangement.
        const artifacts = client.getQueryData<ChannelQueryData | null>(key)?.artifacts;
        return { previous, artifacts };
      },
      onError: (_error, _arrangement, arranged, { client }) => {
        // Only an arrangement nothing has replaced since is still this one to undo.
        client.setQueryData<ChannelQueryData | null>(key, (state) =>
          state && arranged && state.artifacts === arranged.artifacts
            ? { ...state, artifacts: arranged.previous }
            : state,
        );
      },
    });
  },
  markRead: () =>
    mutationOptions({
      mutationFn: (input: { channelId: string; sequence: number }) =>
        markChannelRead({ data: input }),
    }),
  post: () =>
    mutationOptions({
      mutationFn: async (input: PostChannelMessageInput) => {
        const message = await postChannelMessage({ data: input });
        if (
          message?.id !== input.id ||
          !Number.isSafeInteger(message.sequence) ||
          message.sequence <= 0
        ) {
          throw new Error(
            "The server did not confirm delivery. Check the channel before retrying.",
          );
        }
        return message;
      },
      onMutate: (input, { client }) => {
        client.setQueryData<ChannelQueryData | null>(
          channelQueries.detail(input.channelId).queryKey,
          (state) =>
            state && {
              ...state,
              ...reduceChannelState(state, {
                type: "message",
                message: {
                  id: input.id,
                  sender: { type: "user" },
                  content: input.content,
                  ...(input.attachments ? { attachments: input.attachments } : {}),
                  ...(input.threadSequence ? { threadSequence: input.threadSequence } : {}),
                  timestamp: new Date().toISOString(),
                },
              }),
              optimisticMessageIds: [...(state.optimisticMessageIds ?? []), input.id],
            },
        );
      },
      onError: (_error, input, _result, { client }) => {
        client.setQueryData<ChannelQueryData | null>(
          channelQueries.detail(input.channelId).queryKey,
          (state) =>
            state?.optimisticMessageIds?.includes(input.id)
              ? {
                  ...state,
                  optimisticMessageIds: state.optimisticMessageIds.filter((id) => id !== input.id),
                  messages: state.messages.filter(({ id }) => id !== input.id),
                }
              : state,
        );
      },
    }),
};
