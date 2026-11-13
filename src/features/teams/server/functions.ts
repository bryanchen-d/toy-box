import { createServerFn } from "@tanstack/react-start";
import { zodValidator } from "@tanstack/zod-adapter";
import type { Team, TeamList, TeamMessage } from "@teams/model";
import {
  arrangeTeamArtifactsInputSchema,
  teamIdentitySchema,
  teamThreadSequenceSchema,
  createTeamMemberInputSchema,
  createTeamInputSchema,
  editTeamInputSchema,
  markTeamReadInputSchema,
  postTeamMessageInputSchema,
  removeTeamMemberInputSchema,
  teamRoutineIdentitySchema,
  updateTeamMemberInputSchema,
} from "@teams/model";
import * as teams from ".";
import * as advice from "./advice";
import { getTeamPerformance as readTeamPerformance } from "./performance";
import { teamMessageSearchInputSchema } from "@teams/model/search";
import { PERFORMANCE_BUCKETS } from "@teams/model/performance";
import { resolveTeamAdviceInputSchema } from "@teams/model/advice";
import { z } from "zod";
export const listTeams = createServerFn({ method: "GET" }).handler((): Promise<TeamList> =>
  teams.listTeams(),
);

export const getTeamPerformance = createServerFn({ method: "GET" })
  .validator(zodValidator(teamIdentitySchema.extend({ bucket: z.enum(PERFORMANCE_BUCKETS) })))
  .handler(({ data }) => readTeamPerformance(data.teamId, data.bucket));

export const resolveTeamAdvice = createServerFn({ method: "POST" })
  .validator(zodValidator(resolveTeamAdviceInputSchema))
  .handler(({ data }) => advice.resolveTeamAdvice(data));

export const getTeamUsage = createServerFn({ method: "GET" })
  .validator(zodValidator(teamIdentitySchema))
  .handler(({ data }) => teams.getTeamUsage(data.teamId));

export const getTeamThreadSequence = createServerFn({ method: "GET" })
  .validator(zodValidator(teamIdentitySchema.extend({ sequence: teamThreadSequenceSchema })))
  .handler(({ data }) => teams.getTeamThreadSequence(data.teamId, data.sequence));

export const searchTeamMessages = createServerFn({ method: "POST" })
  .validator(zodValidator(teamMessageSearchInputSchema))
  .handler(({ data }) => teams.searchTeamMessages(data.teamId, data.query, data.threadSequence));

export const createTeam = createServerFn({ method: "POST" })
  .validator(zodValidator(createTeamInputSchema))
  .handler(({ data }): Promise<Team> => teams.createTeam(data));

export const createTeamMember = createServerFn({ method: "POST" })
  .validator(zodValidator(createTeamMemberInputSchema))
  .handler(({ data }) => teams.createTeamMember(data));

export const updateTeamMember = createServerFn({ method: "POST" })
  .validator(zodValidator(updateTeamMemberInputSchema))
  .handler(({ data }) => teams.updateTeamMember(data));

export const editTeam = createServerFn({ method: "POST" })
  .validator(zodValidator(editTeamInputSchema))
  .handler(({ data }): Promise<Team> => teams.editTeam(data));

export const deleteTeam = createServerFn({ method: "POST" })
  .validator(zodValidator(teamIdentitySchema))
  .handler(({ data }): Promise<boolean> => teams.deleteTeam(data.teamId));

export const removeTeamMember = createServerFn({ method: "POST" })
  .validator(zodValidator(removeTeamMemberInputSchema))
  .handler(({ data }): Promise<void> => teams.removeTeamMember(data.agentId));

export const deleteTeamRoutine = createServerFn({ method: "POST" })
  .validator(zodValidator(teamRoutineIdentitySchema))
  .handler(({ data }): Promise<boolean> => teams.deleteTeamRoutine(data.teamId, data.routineId));

export const runTeamRoutine = createServerFn({ method: "POST" })
  .validator(zodValidator(teamRoutineIdentitySchema))
  .handler(({ data }): Promise<boolean> => teams.runTeamRoutine(data.teamId, data.routineId));

export const arrangeTeamArtifacts = createServerFn({ method: "POST" })
  .validator(zodValidator(arrangeTeamArtifactsInputSchema))
  .handler(({ data }): Promise<void> => teams.arrangeTeamArtifacts(data));

export const markTeamRead = createServerFn({ method: "POST" })
  .validator(zodValidator(markTeamReadInputSchema))
  .handler(async ({ data }): Promise<void> => {
    await teams.markTeamRead(data.teamId, data.sequence);
  });

export const postTeamMessage = createServerFn({ method: "POST" })
  .validator(zodValidator(postTeamMessageInputSchema))
  .handler(({ data }): Promise<TeamMessage> => teams.postTeamMessage(data));
