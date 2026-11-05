import { mutationOptions } from "@tanstack/react-query";
import {
  applyTeamArtifactArrangement,
  type ArrangeTeamArtifactsInput,
  type CreateTeamMemberInput,
  type CreateTeamInput,
  type EditTeamInput,
  type PostTeamMessageInput,
  type UpdateTeamMemberInput,
} from "@teams/model";
import { teamQueries, type TeamQueryData } from "@teams/queries";
import { reduceTeamState } from "@teams/model/reducer";
import { applyTeamListEvent, invalidateTeamListQuery } from "@teams/queryCache";
import {
  arrangeTeamArtifacts,
  createTeam,
  createTeamMember,
  deleteTeam,
  deleteTeamRoutine,
  editTeam,
  markTeamRead,
  postTeamMessage,
  removeTeamMember,
  runTeamRoutine,
  updateTeamMember,
} from "@teams/server/functions";

export const teamMutations = {
  create: () =>
    mutationOptions({
      mutationFn: (input: CreateTeamInput) => createTeam({ data: input }),
      onSuccess: (_team, _input, _result, { client }) => invalidateTeamListQuery(client),
    }),
  createMember: () =>
    mutationOptions({
      mutationFn: (input: CreateTeamMemberInput) => createTeamMember({ data: input }),
    }),
  updateMember: () =>
    mutationOptions({
      mutationFn: (input: UpdateTeamMemberInput) => updateTeamMember({ data: input }),
    }),
  edit: () =>
    mutationOptions({
      mutationFn: (input: EditTeamInput) => editTeam({ data: input }),
      onSuccess: (_team, _input, _result, { client }) => invalidateTeamListQuery(client),
    }),
  delete: (teamId: string) =>
    mutationOptions({
      mutationFn: () => deleteTeam({ data: { teamId } }),
      onSuccess: (_deleted, _variables, _result, { client }) => {
        applyTeamListEvent(client, { type: "team.deleted", teamId });
      },
    }),
  removeMember: (agentId: string) =>
    mutationOptions({
      mutationFn: () => removeTeamMember({ data: { agentId } }),
    }),
  runRoutine: (teamId: string) =>
    mutationOptions({
      mutationFn: (routineId: string) => runTeamRoutine({ data: { teamId, routineId } }),
    }),
  deleteRoutine: (teamId: string) =>
    mutationOptions({
      mutationFn: (routineId: string) => deleteTeamRoutine({ data: { teamId, routineId } }),
    }),
  /** Arranges at once; the committed `artifacts` event then confirms or corrects it. */
  arrangeArtifacts: (teamId: string) => {
    const key = teamQueries.detail(teamId).queryKey;
    return mutationOptions({
      mutationFn: (arrangement: Omit<ArrangeTeamArtifactsInput, "teamId">) =>
        arrangeTeamArtifacts({ data: { teamId, ...arrangement } }),
      onMutate: (arrangement, { client }) => {
        const previous = client.getQueryData<TeamQueryData | null>(key)?.artifacts;
        if (!previous) return undefined;
        const arranged = applyTeamArtifactArrangement(previous, arrangement);
        client.setQueryData<TeamQueryData | null>(
          key,
          (state) => state && { ...state, artifacts: arranged },
        );
        // Structural sharing stores its own copy, which identifies this arrangement.
        const artifacts = client.getQueryData<TeamQueryData | null>(key)?.artifacts;
        return { previous, artifacts };
      },
      onError: (_error, _arrangement, arranged, { client }) => {
        // Only an arrangement nothing has replaced since is still this one to undo.
        client.setQueryData<TeamQueryData | null>(key, (state) =>
          state && arranged && state.artifacts === arranged.artifacts
            ? { ...state, artifacts: arranged.previous }
            : state,
        );
      },
    });
  },
  markRead: () =>
    mutationOptions({
      mutationFn: (input: { teamId: string; sequence: number }) => markTeamRead({ data: input }),
    }),
  post: () =>
    mutationOptions({
      mutationFn: async (input: PostTeamMessageInput) => {
        const message = await postTeamMessage({ data: input });
        if (
          message?.id !== input.id ||
          !Number.isSafeInteger(message.sequence) ||
          message.sequence <= 0
        ) {
          throw new Error("The server did not confirm delivery. Check the team before retrying.");
        }
        return message;
      },
      onMutate: (input, { client }) => {
        client.setQueryData<TeamQueryData | null>(
          teamQueries.detail(input.teamId).queryKey,
          (state) =>
            state && {
              ...state,
              ...reduceTeamState(state, {
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
        client.setQueryData<TeamQueryData | null>(
          teamQueries.detail(input.teamId).queryKey,
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
