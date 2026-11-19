// RPC boundary for file- and app-owned workers, and for the history of sub sessions. TanStack
// keeps handler-only dependencies in the server graph, so admission remains a plain static import.

import { createServerFn } from "@tanstack/react-start";
import { zodValidator } from "@tanstack/zod-adapter";
import { cancelWorkerInputSchema, spawnWorkerInputSchema } from "../model";
import { SUB_SESSION_HISTORY_MS, type SubSessionRecord } from "../model/subSessions";
import * as workers from "./admission";
import { readSubSessionHistory } from "./database";

/** Spawn a background worker owned by a file or app. */
export const spawnWorker = createServerFn({ method: "POST" })
  .validator(zodValidator(spawnWorkerInputSchema))
  .handler(({ data }): Promise<{ sessionId: string }> => workers.spawnWorkerFromRequest(data));

/** Cancel a queued or running worker through its exact owner. */
export const cancelWorker = createServerFn({ method: "POST" })
  .validator(zodValidator(cancelWorkerInputSchema))
  .handler(({ data }): Promise<boolean> => workers.cancelWorker(data));

/** The sub sessions created or closed in the last week, whoever owned them. */
export const listSubSessionHistory = createServerFn({ method: "GET" }).handler(
  (): Promise<SubSessionRecord[]> =>
    readSubSessionHistory(new Date(Date.now() - SUB_SESSION_HISTORY_MS)),
);
