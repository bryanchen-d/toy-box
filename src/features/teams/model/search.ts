import {
  teamIdentitySchema,
  teamThreadSequenceSchema,
  type TeamConversationMessage,
} from "./index";
import { messageSearchQuerySchema, type MessageSearchMatch } from "@/shared/messages/search";

export const teamMessageSearchInputSchema = teamIdentitySchema.extend({
  query: messageSearchQuerySchema,
  threadSequence: teamThreadSequenceSchema.optional(),
});

export type TeamMessageMatch = MessageSearchMatch &
  Pick<TeamConversationMessage, "sequence" | "sender"> & {
    threadSequence: number;
  };
