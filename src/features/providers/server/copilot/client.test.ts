import { expect, test } from "bun:test";
import type { CopilotClient } from "@github/copilot-sdk";
import { sharedMap } from "@/shared/server/processState";
import { copilotClientStopped, stopCopilotClient } from "./client";

test("stopping the shared client signals every session it served", async () => {
  const client = { stop: async () => [] } as unknown as CopilotClient;
  const stopped = copilotClientStopped(client);
  sharedMap<Promise<CopilotClient>>("copilot-clients").set("shared", Promise.resolve(client));

  await stopCopilotClient();

  expect(stopped.aborted).toBe(true);
});
