import { z } from "zod";
import { workspaceFileId, workspaceFileSchema } from "@files/model";
import { getPathBasename } from "@files/model/paths";

export const sessionSystemMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("file_edited"),
      file: workspaceFileSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("team_message"),
      senderName: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("team_routine"),
      title: z.string().min(1),
      prompt: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("team_follow_up"),
      waitingFor: z.string().min(1),
    })
    .strict(),
]);

export type SessionSystemMessage = z.infer<typeof sessionSystemMessageSchema>;

const SYSTEM_MESSAGE_PREFIX = "agent-teams-system:";

/** Providers keep this display representation in native history alongside the model prompt. */
export function encodeSystemMessage(message: SessionSystemMessage): string {
  return `${SYSTEM_MESSAGE_PREFIX}${JSON.stringify(message)}`;
}

export function decodeSystemMessage(content: string): SessionSystemMessage | undefined {
  if (!content.startsWith(SYSTEM_MESSAGE_PREFIX)) return undefined;
  try {
    const result = sessionSystemMessageSchema.safeParse(
      JSON.parse(content.slice(SYSTEM_MESSAGE_PREFIX.length)),
    );
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function systemMessagePrompt(message: SessionSystemMessage): string {
  switch (message.type) {
    case "file_edited":
      return `The user edited a file open in Agent Teams: ${JSON.stringify(message.file)}. A \`session\` file's \`path\` is relative to that session's artifacts folder, usually your own. A \`machine\` file's \`path\` is an absolute host path. Review its latest contents and respond only if a follow-up would help.`;
    case "team_message":
      return `A new public message from ${message.senderName} is waiting in a team you belong to. Call \`read_team\` to consume messages since your last read.`;
    case "team_routine":
      return `Your routine ${JSON.stringify(message.title)} is due: ${JSON.stringify(message.prompt)}. Call \`read_team\`, then do it. If nothing needs the team's attention, finish quietly.`;
    case "team_follow_up":
      return `Your follow-up is due. You were waiting for ${message.waitingFor}. Call \`read_team\` and check whether you can continue.`;
  }
}

export function systemMessageLabel(message: SessionSystemMessage): string {
  switch (message.type) {
    case "file_edited":
      return `Edited ${getPathBasename(message.file.path)}`;
    case "team_message":
      return `Message from ${message.senderName}`;
    case "team_routine":
      return `Routine: ${message.title}`;
    case "team_follow_up":
      return `Follow-up: ${message.waitingFor}`;
  }
}

/** Collapse equivalent queued system messages so the agent is not nudged twice. */
export function systemMessageCoalesceKey(message: SessionSystemMessage): string | undefined {
  switch (message.type) {
    case "file_edited":
      return `file_edited:${workspaceFileId(message.file)}`;
    case "team_message":
      return "team_message";
    case "team_routine":
      return `team_routine:${message.prompt}`;
    case "team_follow_up":
      return "team_follow_up";
  }
}
