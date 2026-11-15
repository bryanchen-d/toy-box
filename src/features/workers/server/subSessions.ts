// Sub sessions: the session-owned Workers an agent creates, messages, lists, and closes. Every
// operation acts only on the caller's own sub sessions.

import type { ModelConfiguration } from "@providers/model";
import {
  deliverSessionMessage,
  getSessionRuntimeStatus,
  waitForSessions,
} from "@sessions/server/runtime";
import {
  renderSubSessionBrief,
  SUB_SESSION_LIMIT,
  type SubSessionBrief,
} from "../model/subSessions";
import type { Worker } from "../model";
import { spawnSessionWorker } from "./admission";
import { deleteWorker } from "./cleanup";
import { getPersistedWorker } from "./database";
import { getWorker, listWorkers } from "./index";

const REPORT_PREVIEW_LENGTH = 1_000;

export type SubSessionRequest = {
  name: string;
  brief: SubSessionBrief;
  model?: ModelConfiguration;
  directory?: string;
  useWorktree?: boolean;
};

export type SubSessionSummary = {
  sessionId: string;
  name?: string;
  createdAt: string;
  state: "working" | "idle";
  queuedMessages: number;
  lastReport?: string;
  lastError?: string;
};

/** Creations are serialized per owner, so parallel calls can't exceed the limit. */
const creations = new Map<string, Promise<unknown>>();

export function createSubSession(
  ownerSessionId: string,
  request: SubSessionRequest,
): Promise<{ sessionId: string }> {
  const previous = creations.get(ownerSessionId) ?? Promise.resolve();
  const creation = previous.catch(() => {}).then(() => admit(ownerSessionId, request));
  creations.set(ownerSessionId, creation);
  void creation
    .catch(() => {})
    .finally(() => {
      if (creations.get(ownerSessionId) === creation) creations.delete(ownerSessionId);
    });
  return creation;
}

async function admit(
  ownerSessionId: string,
  { name, brief, model, directory, useWorktree }: SubSessionRequest,
): Promise<{ sessionId: string }> {
  const owner = await getPersistedWorker(ownerSessionId);
  if (owner?.type === "session") {
    throw new Error(
      "A sub session can't create sub sessions of its own. Report what you need to your owner instead.",
    );
  }
  const open = await ownedSubSessions(ownerSessionId);
  if (open.length >= SUB_SESSION_LIMIT) {
    const names = open.map((worker) => worker.name ?? worker.sessionId).join(", ");
    throw new Error(
      `You already own ${open.length} sub sessions (${names}), the most you can have open. Close one whose task is done before creating another.`,
    );
  }
  return spawnSessionWorker({
    parentSessionId: ownerSessionId,
    name,
    message: { content: renderSubSessionBrief(brief, { name: owner?.name }), model },
    location: { directory, useWorktree },
  });
}

/** Sends a follow-up, which starts the sub session's next turn or waits behind its current one. */
export async function messageSubSession(
  ownerSessionId: string,
  sessionId: string,
  message: string,
  clientId?: string,
): Promise<{ disposition: string }> {
  await requireOwned(ownerSessionId, sessionId);
  const { disposition } = await deliverSessionMessage(sessionId, {
    content: message,
    ...(clientId ? { clientId } : {}),
  });
  return { disposition };
}

export async function listSubSessions(ownerSessionId: string): Promise<{
  subSessions: SubSessionSummary[];
  limit: number;
}> {
  const workers = await ownedSubSessions(ownerSessionId);
  const subSessions = await Promise.all(workers.map(summarize));
  return { subSessions, limit: SUB_SESSION_LIMIT };
}

/** Stops the sub session's work and deletes it. */
export async function closeSubSession(
  ownerSessionId: string,
  sessionId: string,
): Promise<{ closed: true }> {
  await requireOwned(ownerSessionId, sessionId);
  await deleteWorker(sessionId, "session");
  return { closed: true };
}

async function ownedSubSessions(ownerSessionId: string) {
  const workers = await listWorkers({ type: "session", parentSessionId: ownerSessionId });
  return workers.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function requireOwned(ownerSessionId: string, sessionId: string): Promise<void> {
  if (!(await getWorker(sessionId, { type: "session", parentSessionId: ownerSessionId }))) {
    throw new Error(
      `Session ${sessionId} is not one of your sub sessions. list_sub_sessions shows the ones you own.`,
    );
  }
}

async function summarize(worker: Worker): Promise<SubSessionSummary> {
  const { running, queuedCount } = getSessionRuntimeStatus(worker.sessionId);
  const summary: SubSessionSummary = {
    sessionId: worker.sessionId,
    ...(worker.name ? { name: worker.name } : {}),
    createdAt: worker.createdAt,
    state: running ? "working" : "idle",
    queuedMessages: queuedCount,
  };
  if (running) return summary;
  const [completion] = await waitForSessions([worker.sessionId], 0);
  return {
    ...summary,
    ...(completion?.response ? { lastReport: preview(completion.response) } : {}),
    ...(completion?.error ? { lastError: preview(completion.error) } : {}),
  };
}

function preview(text: string): string {
  return text.length <= REPORT_PREVIEW_LENGTH
    ? text
    : `${text.slice(0, REPORT_PREVIEW_LENGTH)}… (truncated)`;
}
