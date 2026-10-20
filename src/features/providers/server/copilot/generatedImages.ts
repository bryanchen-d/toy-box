import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionHooks } from "@github/copilot-sdk";

type PostToolUse = NonNullable<SessionHooks["onPostToolUse"]>;

// Workaround seen through CLI 1.0.100-1: image_generation returns images without saving
// them and has no output path. TODO: Remove when Copilot can write generated images to disk itself.
/** Save generated images like Codex does, and tell the model where so agents can attach them. */
export async function saveGeneratedImages(
  { toolName, toolResult }: Parameters<PostToolUse>[0],
  { sessionId }: Parameters<PostToolUse>[1],
  home = homedir(),
) {
  if (toolName !== "image_generation") return;
  const paths = await Promise.all(
    (toolResult.binaryResultsForLlm ?? [])
      .filter(({ type }) => type === "image")
      .map(async ({ data, mimeType }) => {
        const bytes = Buffer.from(data, "base64");
        // The content hash matches the image_id Copilot reports to the model.
        const name = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        const path = join(
          home,
          ".copilot",
          "generated_images",
          sessionId,
          `${name}.${mimeType.split("/")[1]}`,
        );
        await Bun.write(path, bytes);
        return path;
      }),
  );
  if (paths.length)
    return { additionalContext: `Saved the generated image to ${paths.join(", ")}.` };
}
