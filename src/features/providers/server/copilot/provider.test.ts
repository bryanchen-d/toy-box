import { beforeEach, expect, mock, onTestFinished, spyOn, test } from "bun:test";
import type { CopilotClient } from "@github/copilot-sdk";
import type { SessionEvent } from "@sessions/model";
import * as client from "./client";
import { copilotProvider } from "./provider";
import * as computerUse from "./computerUse";
import { saveGeneratedImages } from "./generatedImages";

beforeEach(() => {
  const servers = spyOn(computerUse, "computerUseServers").mockResolvedValue({
    "computer-use": { type: "stdio", command: "/copilot/computer-use-mcp" },
  });
  onTestFinished(() => servers.mockRestore());
});

test("catalog metadata retains the native repository display fields", async () => {
  const start = spyOn(client, "startCopilotClient").mockResolvedValue({
    listSessions: async () => [
      {
        sessionId: "native",
        startTime: new Date(0),
        modifiedTime: new Date(1),
        summary: "Repository session",
        context: {
          workingDirectory: "/repo/src",
          gitRoot: "/repo",
          repository: "owner/repo",
          branch: "main",
        },
      },
    ],
  } as unknown as CopilotClient);
  onTestFinished(() => start.mockRestore());

  expect(await copilotProvider.listSessions()).toEqual([
    {
      id: "native",
      createdAt: new Date(0),
      updatedAt: new Date(1),
      title: "Repository session",
      context: {
        directory: "/repo/src",
        gitRoot: "/repo",
        repository: "owner/repo",
        branch: "main",
      },
    },
  ]);
});

test("creation uses the canonical ID and configures the working directory", async () => {
  const createSession = mock(async ({ sessionId }: { sessionId: string }) => ({
    sessionId,
    on: () => () => {},
  }));
  const start = spyOn(client, "startCopilotClient").mockResolvedValue({
    createSession,
  } as unknown as CopilotClient);
  onTestFinished(() => start.mockRestore());

  const model = { provider: "copilot", name: "gpt-5.4-mini", reasoningEffort: "none" };
  const connection = await copilotProvider.create("public", {
    model,
    directory: "/repo",
    allowUserQuestions: false,
    tools: [],
    instructions: "",
    skillDirectories: [],
  });

  expect(createSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "public",
      workingDirectory: "/repo",
      mcpServers: { "computer-use": { type: "stdio", command: "/copilot/computer-use-mcp" } },
      hooks: { onPostToolUse: saveGeneratedImages },
    }),
  );
  expect(connection.provider).toEqual({
    id: "copilot",
    sessionId: "public",
  });
  const events: SessionEvent[] = [];
  connection.onEvent((event) => events.push(event));
  expect(events).toEqual([{ type: "model_changed", model }]);
});

test("resume requests the configured model and computer use from the native session", async () => {
  const resumeSession = mock(async (_id: string, _configuration: object) => ({
    sessionId: "native",
  }));
  const start = spyOn(client, "startCopilotClient").mockResolvedValue({
    resumeSession,
  } as unknown as CopilotClient);
  onTestFinished(() => start.mockRestore());

  await copilotProvider.resume(
    { id: "public", provider: { id: "copilot", sessionId: "native" } },
    {
      model: {
        provider: "copilot",
        name: "gpt-6-luna",
        reasoningEffort: "max",
        contextTier: "long_context",
      },
      directory: "/repo",
      allowUserQuestions: false,
      tools: [],
      instructions: "",
      skillDirectories: [],
    },
  );

  expect(resumeSession).toHaveBeenCalledWith(
    "native",
    expect.objectContaining({
      model: "gpt-6-luna",
      reasoningEffort: "max",
      contextTier: "long_context",
      mcpServers: { "computer-use": { type: "stdio", command: "/copilot/computer-use-mcp" } },
      hooks: { onPostToolUse: saveGeneratedImages },
    }),
  );
});

test("read-only history preserves attachments and projector state across native pages", async () => {
  const read = mock(async ({ cursor }: { cursor?: string }) => ({
    cursor: cursor ? "end" : "next",
    hasMore: !cursor,
    events: cursor
      ? [
          {
            type: "user.message",
            timestamp: "2026-09-14T00:00:00.000Z",
            data: {
              content: "Review the attachments",
              attachments: [
                { type: "blob", assetId: "sha256:image", mimeType: "image/png" },
                { type: "blob", data: "bm90ZXM=", mimeType: "text/plain" },
                { type: "file", assetId: "sha256:image", path: "/tmp/removed.png" },
              ],
            },
          },
        ]
      : [
          {
            type: "session.binary_asset",
            data: {
              assetId: "sha256:image",
              type: "image",
              data: "aW1hZ2U=",
              mimeType: "image/png",
              byteLength: 5,
            },
          },
        ],
  }));
  const start = spyOn(client, "startCopilotClient").mockResolvedValue({
    rpc: { sessions: { readPersistedEvents: read } },
  } as unknown as CopilotClient);
  onTestFinished(() => start.mockRestore());

  expect(
    await copilotProvider.readHistory({
      id: "public",
      provider: { id: "copilot", sessionId: "native" },
    }),
  ).toEqual([
    {
      type: "user_message",
      content: "Review the attachments",
      timestamp: "2026-09-14T00:00:00.000Z",
      attachments: [
        { mimeType: "image/png", base64: "aW1hZ2U=" },
        { mimeType: "text/plain", base64: "bm90ZXM=" },
        { mimeType: "image/png", base64: "aW1hZ2U=" },
      ],
    },
  ]);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith({
    sessionId: "native",
    direction: "forward",
    max: 1000,
    cursor: "next",
  });
});
