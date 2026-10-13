import { z } from "zod";

const previewUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine(
    (url) => {
      if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith("/\\")) return true;
      try {
        return ["http:", "https:"].includes(new URL(url).protocol);
      } catch {
        return false;
      }
    },
    { message: "Use a root-relative, HTTP, or HTTPS preview URL." },
  );

/** A published runnable result. Its owner stores the reference, not the running resource. */
export const previewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: previewUrlSchema }).strict(),
  z.object({ kind: z.literal("screen"), screenId: z.string().trim().min(1).max(255) }).strict(),
]);
export type Preview = z.infer<typeof previewSchema>;

export const previewUpdateSchema = z.object({ preview: previewSchema.nullable() }).strict();
