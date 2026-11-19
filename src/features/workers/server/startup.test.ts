import { afterAll, expect, mock, test } from "bun:test";
import { publishSessionCompletion } from "@sessions/server/runtime/completions";
import * as subSessionsModule from "./subSessions";
import * as supervisorModule from "./supervisor";

const realSubSessionsModule = { ...subSessionsModule };
const realSupervisorModule = { ...supervisorModule };

const reportToOwner = mock(async () => {});
mock.module("./subSessions", () => ({
  ...realSubSessionsModule,
  reportToOwner,
  noteWorking: async () => {},
  reportInterruptedSubSessions: async () => {},
  wakeDueSubSessions: async () => {},
  remindOwnersOfIdleSubSessions: async () => {},
}));
mock.module("./supervisor", () => ({
  ...realSupervisorModule,
  ensureWorkersSwept: async () => {},
}));

afterAll(() => {
  mock.module("./subSessions", () => realSubSessionsModule);
  mock.module("./supervisor", () => realSupervisorModule);
});

const { default: startWorkers } = await import("./startup");

test("rerunning startup, as a dev reload does, reports each finished execution once", async () => {
  await startWorkers();
  const stop = await startWorkers();

  publishSessionCompletion("sub-1", { status: "completed", response: "Done." });
  stop();

  expect(reportToOwner).toHaveBeenCalledTimes(1);
});
