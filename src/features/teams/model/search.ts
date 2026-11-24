import {
  teamIdentitySchema,
  teamTaskIdSchema,
  teamThreadSequenceSchema,
  type TeamConversationMessage,
} from "./index";
import { messageSearchQuerySchema, type MessageSearchMatch } from "@/shared/messages/search";

export const teamMessageSearchInputSchema = teamIdentitySchema.extend({
  query: messageSearchQuerySchema,
  threadSequence: teamThreadSequenceSchema.optional(),
});

/** Where a message is: its own sequence, and the sequence of the thread it starts or joins. */
export type TeamMessageLocation = Pick<TeamConversationMessage, "sequence"> & {
  threadSequence: number;
};

export type TeamMessageMatch = MessageSearchMatch &
  TeamMessageLocation &
  Pick<TeamConversationMessage, "sender">;

export const teamTaskMessageInputSchema = teamIdentitySchema.extend({
  taskId: teamTaskIdSchema,
});
