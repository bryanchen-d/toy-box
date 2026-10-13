import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveGeneratedImages } from "./generatedImages";

let home: string | undefined;
afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

function completion(toolName: string) {
  return {
    toolName,
    toolArgs: {},
    toolResult: {
      textResultForLlm: "Done",
      resultType: "success" as const,
      binaryResultsForLlm: [
        { type: "image" as const, data: btoa("png bytes"), mimeType: "image/png" },
      ],
    },
    sessionId: "session",
    timestamp: new Date(0),
    workingDirectory: "/repo",
  };
}

test("generated images are saved under the session and reported to the model", async () => {
  home = await mkdtemp(join(tmpdir(), "toy-box-generated-images-"));
  const name = new Bun.CryptoHasher("sha256").update("png bytes").digest("hex");
  const path = join(home, ".copilot", "generated_images", "session", `${name}.png`);

  expect(
    await saveGeneratedImages(completion("image_generation"), { sessionId: "session" }, home),
  ).toEqual({ additionalContext: `Saved the generated image to ${path}.` });
  expect(await Bun.file(path).text()).toBe("png bytes");
});

test("images from other tools are not saved", async () => {
  home = await mkdtemp(join(tmpdir(), "toy-box-generated-images-"));

  expect(await saveGeneratedImages(completion("view"), { sessionId: "session" }, home)).toBe(
    undefined,
  );
  expect(existsSync(join(home, ".copilot"))).toBe(false);
});
