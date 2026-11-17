// Sub sessions: the session-owned Workers an agent creates, messages, lists, and closes. Every
// operation acts only on the caller's own sub sessions.

import {
  deliverSessionMessage,
  getSessionRuntimeStatus,
  waitForSessions,
} from "@sessions/server/runtime";
import type { SessionCompletion } from "@sessions/model";
import { takeExternalWrites } from "@security/server/guard";
import {
  dueWake,
  isReminderDue,
  readSubSessionMetadata,
  renderSubSessionBrief,
  SUB_SESSION_LIMIT,
  SUB_SESSION_REMINDER_MS,
  subSessionReport,
  type SubSessionRequest,
} from "../model/subSessions";
import type { Worker } from "../model";
import { spawnSessionWorker } from "./admission";
import { deleteWorker } from "./cleanup";
import { getPersistedWorker } from "./database";
import { getWorker, listWorkers, updateWorker } from "./index";

const REPORT_PREVIEW_LENGTH = 1_000;

type SubSessionSummary = {
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
  { name, brief, model, directory, useWorktree, node }: SubSessionRequest,
): Promise<{ sessionId: string }> {
  const owner = await getPersistedWorker(ownerSessionId);
  if (owner?.type === "session") {
    throw new Error(
      "A sub session can't create sub sessions of its own. Report what you need to your owner instead.",
    );
  }
  if (node && (directory !== undefined || useWorktree)) {
    throw new Error(
      "A sub session on a node starts in its own folder there; leave directory and useWorktree unset.",
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
    message: {
      content: renderSubSessionBrief(brief, { name: owner?.name }),
      model: node ? await nodeModel(node, model) : model,
    },
    location: { directory, useWorktree },
  });
}

/** A node runs its sub sessions as its own provider, with the named model if the node has it. */
async function nodeModel(node: string, model: SubSessionRequest["model"]) {
  const { getSessionProvider } = await import("@providers/server");
  const { nodeProviderId } = await import("@providers/server/agentHost/provider");
  const provider = nodeProviderId(node);
  getSessionProvider(provider);
  return { provider, name: model?.name ?? "auto" };
}

/** Sends a follow-up, which starts the sub session's next turn or waits behind its current one. */
export async function messageSubSession(
  ownerSessionId: string,
  sessionId: string,
  message: string,
  clientId?: string,
): Promise<{ disposition: string }> {
  const worker = await requireOwned(ownerSessionId, sessionId);
  // The owner's message supersedes whatever the sub session planned to check on.
  if (worker.metadata !== undefined) await updateWorker(sessionId, { metadata: undefined });
  const { disposition } = await deliverSessionMessage(sessionId, {
    content: message,
    ...(clientId ? { clientId } : {}),
  });
  return { disposition };
}

export async function listSubSessions(ownerSessionId: string) {
  const workers = await ownedSubSessions(ownerSessionId);
  return { subSessions: await Promise.all(workers.map(summarize)) };
}

/** Stops the sub session's work and deletes it, returning any external writes not yet reported. */
export async function closeSubSession(
  ownerSessionId: string,
  sessionId: string,
): Promise<{ closed: true; unreportedExternalWrites?: string[] }> {
  await requireOwned(ownerSessionId, sessionId);
  await deleteWorker(sessionId, "session");
  const unreported = takeExternalWrites(sessionId);
  return unreported.length > 0
    ? { closed: true, unreportedExternalWrites: unreported }
    : { closed: true };
}

/**
 * Wakes a sub session's owner with what its finished execution reports, if anything, and sets
 * the reminder its owner gets if the sub session then sits idle. A sub session closed in the
 * meantime reports nothing.
 */
export async function reportToOwner(
  sessionId: string,
  completion: SessionCompletion,
  now = new Date(),
): Promise<void> {
  const worker = await getPersistedWorker(sessionId);
  if (worker?.type !== "session") return;
  const report = subSessionReport(completion, takeExternalWrites(sessionId));
  if (!report) return;
  const remindAt = new Date(now.getTime() + SUB_SESSION_REMINDER_MS).toISOString();
  await updateWorker(sessionId, {
    metadata: { ...readSubSessionMetadata(worker.metadata), remindAt },
  });
  await deliverSessionMessage(worker.parentSessionId, {
    systemMessage: {
      type: "sub_session_report",
      sessionId,
      name: worker.name ?? "Sub session",
      ...report,
    },
    immediate: true,
  });
}

/** A sub session schedules its own next turn while it waits on something slow. */
export async function scheduleWake(
  sessionId: string,
  minutes: number,
  reason: string,
  now = new Date(),
): Promise<{ wakeAt: string }> {
  const worker = await getPersistedWorker(sessionId);
  if (worker?.type !== "session") throw new Error("Only a sub session can schedule a wake.");
  const wakeAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  await updateWorker(sessionId, {
    metadata: { ...readSubSessionMetadata(worker.metadata), wake: { at: wakeAt, reason } },
  });
  return { wakeAt };
}

/** Starts the next turn of every sub session whose wake is due. Each claim commits first. */
export async function wakeDueSubSessions(now = new Date()): Promise<void> {
  for (const worker of await listWorkers("session")) {
    const wake = dueWake(worker.metadata, now);
    if (!wake) continue;
    const { wake: _claimed, ...metadata } = readSubSessionMetadata(worker.metadata);
    await updateWorker(worker.sessionId, { metadata });
    await deliverSessionMessage(worker.sessionId, {
      systemMessage: { type: "sub_session_wake", reason: wake.reason },
    }).catch((error: unknown) =>
      console.error(`Could not wake sub session ${worker.sessionId}:`, error),
    );
  }
}

/** Reminds each owner, once, of a sub session left idle since its last report. */
export async function remindOwnersOfIdleSubSessions(now = new Date()): Promise<void> {
  for (const worker of await listWorkers("session")) {
    if (!isReminderDue(worker.metadata, now)) continue;
    if (getSessionRuntimeStatus(worker.sessionId).running) continue;
    const { remindAt: _claimed, ...metadata } = readSubSessionMetadata(worker.metadata);
    await updateWorker(worker.sessionId, { metadata });
    await deliverSessionMessage(worker.parentSessionId, {
      systemMessage: {
        type: "sub_session_idle",
        sessionId: worker.sessionId,
        name: worker.name ?? "Sub session",
      },
    }).catch((error: unknown) =>
      console.error(`Could not remind the owner of sub session ${worker.sessionId}:`, error),
    );
  }
}

async function ownedSubSessions(ownerSessionId: string) {
  const workers = await listWorkers({ type: "session", parentSessionId: ownerSessionId });
  return workers.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

async function requireOwned(ownerSessionId: string, sessionId: string): Promise<Worker> {
  const worker = await getWorker(sessionId, { type: "session", parentSessionId: ownerSessionId });
  if (!worker) {
    throw new Error(
      `Session ${sessionId} is not one of your sub sessions. list_sub_sessions shows the ones you own.`,
    );
  }
  return worker;
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
