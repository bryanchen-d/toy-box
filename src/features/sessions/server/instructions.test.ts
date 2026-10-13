import { expect, test } from "bun:test";
import { sessionArtifactsDirectory } from "./artifacts";
import { buildSessionSystemPrompt, SESSION_HISTORY_DISCOVERY_INSTRUCTIONS } from "./instructions";

test("instructions identify session resources and preserve the initial subject and host policy", () => {
  const sessionId = "example-session";
  const model = { provider: "codex", name: "model", reasoningEffort: "high" };
  const content = buildSessionSystemPrompt(sessionId, {
    directory: "/workspace",
    model,
    artifactPath: "initial-diagram.svg",
    additionalInstructions: "Follow this role's contract.",
  });

  for (const expected of [
    sessionId,
    "/workspace",
    JSON.stringify(model),
    sessionArtifactsDirectory(sessionId),
    "initial-diagram.svg",
    "Follow this role's contract.",
  ])
    expect(content).toContain(expected);
});

test("session references direct the agent to the supplied public ID", () => {
  expect(SESSION_HISTORY_DISCOVERY_INSTRUCTIONS).toContain("[Title](session:PUBLIC_ID)");
  expect(SESSION_HISTORY_DISCOVERY_INSTRUCTIONS).toContain("URL-escaped public Toy Box ID");
  expect(SESSION_HISTORY_DISCOVERY_INSTRUCTIONS).toContain(
    "call read_session with that ID directly",
  );
  expect(SESSION_HISTORY_DISCOVERY_INSTRUCTIONS).toContain("do not list sessions");
});

test("file references direct the agent to the encoded path rather than the display name", () => {
  const content = buildSessionSystemPrompt("file-reference-test", { directory: "/workspace" });
  expect(content).toContain("[Name](file:PATH)");
  expect(content).toContain("URL-escaped path");
  expect(content).toContain("relative to the working directory");
  expect(content).toContain("do not search by it");
});
