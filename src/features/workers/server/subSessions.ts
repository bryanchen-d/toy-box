// Sub sessions: the session-owned Workers an agent creates, messages, lists, and closes. Every
// operation acts only on the caller's own sub sessions.

import {
  deliverSessionMessage,
  getSessionRuntimeStatus,
  waitForSessions,
} from "@sessions/server/runtime";
import { readSession } from "@sessions/server/state/sessions";
import type { SessionCompletion } from "@sessions/model";
import { nodeProviderId, providerNode } from "@providers/model";
import { poolNodes } from "@connectors/model";
import { takeExternalWrites } from "@security/server/guard";
import {
  dueWake,
  interruptedReport,
  isReminderDue,
  readSubSessionMetadata,
  renderSubSessionBrief,
  SUB_SESSION_LIMIT,
  SUB_SESSION_REMINDER_MS,
  subSessionReport,
  type SubSessionMetadata,
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
  /** The pool node it runs on; absent when it runs on this machine. */
  node?: string;
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
    metadata: { brief } satisfies SubSessionMetadata,
    message: {
      content: renderSubSessionBrief(brief, { name: owner?.name, node }),
      model: node ? await nodeModel(node, model) : model,
    },
    location: { directory, useWorktree },
  });
}

/** A node runs its sub sessions as its own provider, with the named model if the node has it. */
async function nodeModel(node: string, model: SubSessionRequest["model"]) {
  const { getSessionProvider } = await import("@providers/server");
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
  await requireOwned(ownerSessionId, sessionId);
  // The owner's message supersedes whatever the sub session planned to check on.
  await editMetadata(sessionId, ({ wake: _wake, remindAt: _remindAt, ...metadata }) => metadata);
  const { disposition } = await deliverSessionMessage(sessionId, {
    content: message,
    ...(clientId ? { clientId } : {}),
  });
  return { disposition };
}

/** The caller's sub sessions and, when there is an agent pool, the nodes they can run on. */
export async function listSubSessions(ownerSessionId: string) {
  const [workers, nodes] = await Promise.all([ownedSubSessions(ownerSessionId), listNodes()]);
  return {
    subSessions: await Promise.all(workers.map(summarize)),
    ...(nodes.length ? { nodes } : {}),
  };
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
 * Wakes a sub session's owner with what its finished execution reports, if anything. A run that
 * failed while its node was out of reach was interrupted rather than failed. A sub session closed
 * in the meantime reports nothing.
 */
export async function reportToOwner(
  sessionId: string,
  completion: SessionCompletion,
  now = new Date(),
): Promise<void> {
  const worker = await getPersistedWorker(sessionId);
  if (worker?.type !== "session") return;
  const writes = takeExternalWrites(sessionId);
  const node = await nodeOf(sessionId);
  const nodeLost =
    completion.status === "failed" &&
    node !== undefined &&
    (await listNodes()).find(({ name }) => name === node)?.state !== "connected";
  const report = nodeLost
    ? interruptedReport(
        completion.error ?? `${node} went out of reach.`,
        readSubSessionMetadata(worker.metadata).brief,
        writes,
      )
    : subSessionReport(completion, writes);
  if (report) await tellOwner(worker, report, now);
}

/**
 * Tells each owner of a sub session whose run stopped when Agent Teams did. A run on a node may
 * have gone on there. Runs on startup, when no run of an earlier process is still live.
 */
export async function reportInterruptedSubSessions(now = new Date()): Promise<void> {
  for (const worker of await listWorkers("session")) {
    const { working, brief } = readSubSessionMetadata(worker.metadata);
    if (!working || getSessionRuntimeStatus(worker.sessionId).running) continue;
    await editMetadata(worker.sessionId, ({ working: _working, ...metadata }) => metadata);
    const node = await nodeOf(worker.sessionId);
    const reason = node
      ? `Agent Teams restarted while it was working on ${node}, where its run may have gone on.`
      : "Agent Teams restarted while it was working, which stopped its run.";
    await tellOwner(worker, interruptedReport(reason, brief), now).catch((error: unknown) =>
      console.error(`Could not tell the owner of sub session ${worker.sessionId}:`, error),
    );
  }
}

/** Records whether a sub session has a run under way, so a restart can report it interrupted. */
export function noteWorking(sessionId: string, working: boolean): Promise<unknown> {
  return editMetadata(sessionId, ({ working: _working, ...metadata }) =>
    working ? { ...metadata, working: true } : metadata,
  );
}

/** Delivers a report and sets the reminder the owner gets if the sub session then sits idle. */
async function tellOwner(
  worker: Worker & { type: "session" },
  report: NonNullable<ReturnType<typeof subSessionReport>>,
  now: Date,
): Promise<void> {
  const remindAt = new Date(now.getTime() + SUB_SESSION_REMINDER_MS).toISOString();
  await editMetadata(worker.sessionId, (metadata) => ({ ...metadata, remindAt }));
  await deliverSessionMessage(worker.parentSessionId, {
    systemMessage: {
      type: "sub_session_report",
      sessionId: worker.sessionId,
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
  const wakeAt = new Date(now.getTime() + minutes * 60_000).toISOString();
  const worker = await editMetadata(sessionId, (metadata) => ({
    ...metadata,
    wake: { at: wakeAt, reason },
  }));
  if (!worker) throw new Error("Only a sub session can schedule a wake.");
  return { wakeAt };
}

/** Starts the next turn of every sub session whose wake is due. Each claim commits first. */
export async function wakeDueSubSessions(now = new Date()): Promise<void> {
  for (const worker of await listWorkers("session")) {
    if (!dueWake(worker.metadata, now)) continue;
    let wake: SubSessionMetadata["wake"];
    await editMetadata(worker.sessionId, (metadata) => {
      wake = dueWake(metadata, now);
      const { wake: _claimed, ...rest } = metadata;
      return wake ? rest : metadata;
    });
    if (!wake) continue;
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
    let due = false;
    await editMetadata(worker.sessionId, (metadata) => {
      due = isReminderDue(metadata, now);
      const { remindAt: _claimed, ...rest } = metadata;
      return due ? rest : metadata;
    });
    if (!due) continue;
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

// Each edit reads and rewrites the whole metadata, so edits to one sub session run in turn.
const metadataEdits = new Map<string, Promise<unknown>>();

/** Rewrites a sub session's metadata, resolving to its Worker, or undefined if it isn't one. */
function editMetadata(
  sessionId: string,
  edit: (metadata: SubSessionMetadata) => SubSessionMetadata,
): Promise<(Worker & { type: "session" }) | undefined> {
  const previous = metadataEdits.get(sessionId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const worker = await getPersistedWorker(sessionId);
      if (worker?.type !== "session") return undefined;
      await updateWorker(sessionId, { metadata: edit(readSubSessionMetadata(worker.metadata)) });
      return worker;
    });
  metadataEdits.set(sessionId, next);
  void next
    .catch(() => {})
    .finally(() => {
      if (metadataEdits.get(sessionId) === next) metadataEdits.delete(sessionId);
    });
  return next;
}

/** The pool node a sub session runs on, if it runs on one. */
async function nodeOf(sessionId: string): Promise<string | undefined> {
  return providerNode((await readSession(sessionId))?.provider?.id);
}

/** Every pool node with its connection state. */
async function listNodes() {
  const { listConnectors } = await import("@connectors/server");
  return (await listConnectors()).flatMap(poolNodes);
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
  const node = await nodeOf(worker.sessionId);
  const summary: SubSessionSummary = {
    sessionId: worker.sessionId,
    ...(worker.name ? { name: worker.name } : {}),
    ...(node ? { node } : {}),
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
