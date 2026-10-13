import { z } from "zod";
import { draftKeySchema, savedDraftSchema } from "./drafts";

/** Client-issued workspace transitions, validated by the workspace RPC. */
export const workspaceActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("draft.changed"),
    key: draftKeySchema,
    draft: savedDraftSchema,
  }),
  sessionAction("hyper.promoted"),
  sessionAction("read"),
]);

export type WorkspaceAction = z.infer<typeof workspaceActionSchema>;

function sessionAction<Name extends string>(name: Name) {
  return z.object({ type: z.literal(`session.${name}`), sessionId: z.string() });
}
