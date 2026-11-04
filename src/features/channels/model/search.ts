import {
  channelIdentitySchema,
  channelThreadSequenceSchema,
  type ChannelConversationMessage,
} from "./index";
import { messageSearchQuerySchema, type MessageSearchMatch } from "@/shared/messages/search";

export const channelMessageSearchInputSchema = channelIdentitySchema.extend({
  query: messageSearchQuerySchema,
  threadSequence: channelThreadSequenceSchema.optional(),
});

export type ChannelMessageMatch = MessageSearchMatch &
  Pick<ChannelConversationMessage, "sequence" | "sender"> & {
    threadSequence: number;
  };
