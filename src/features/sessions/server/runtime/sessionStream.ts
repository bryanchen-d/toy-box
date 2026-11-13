// One live session runtime. A SessionStream owns a provider connection,
// reduced live state, queued turns, completion waiters, and a replayable event
// bus. It is the one live execution path shared by connected and headless
// delivery.
//
// The event bus stamps eventId for reconnect cursors. Client-provided message
// identity is correlated separately when the provider echoes sent inputs.
// Every emitted event is also observed for hourly activity, which is persisted
// without delaying emission.

import type { SessionConnection } from "@providers/server/provider";
import { evictCachedSessionIfStale, releaseSession } from "@sessions/server/state/registry";
import { cacheSnapshot, loadSessionSnapshot } from "@sessions/server/state/snapshots";
import { setSessionStatus } from "@workspace/server/state";
import { systemMessageCoalesceKey } from "@sessions/model/systemMessages";
import { areModelConfigurationsEqual, type ModelConfiguration } from "@providers/model";
import type { SessionQuestionAnswer, SessionSubscriptionMode } from "@sessions/model/protocol";
import { applySessionEvent, createInitialSessionState } from "@sessions/model/reducer";
import {
  createSessionActivity,
  observeActivity,
  type SessionActivity,
} from "@sessions/model/activity";
import { recordSessionActivity } from "@sessions/server/activity";
import { hasBlockingSessionQuestion, hasPendingSessionQuestion } from "@sessions/model/questions";
import type {
  SessionArtifact,
  SessionCompletion,
  SessionEvent,
  SessionMessage,
  SessionState,
} from "@sessions/model";
import { broadcast } from "@workspace/server/events";
import { sharedMap } from "@/shared/server/processState";
import { createSessionEventBus, type SessionStreamSubscription } from "./eventBus";

/** A first message starts a turn; an immediate one steers the running turn; any other waits. */
export type MessageDisposition = "started" | "steered" | "queued";
type StreamEndReason = Extract<SessionEvent, { type: "end" }>["reason"];

// Replay and per-observer count cap; the bus also owns their UTF-8 byte budget.
// Expired replay and lagging observers reject without stopping provider work.
const MAX_REPLAY_EVENTS = 1500;

/** How the owner answers an approval request; the first choice allows. */
const APPROVAL_CHOICES = ["Allow", "Deny"] as const;

// Dev HMR can reload this module while active turns are still running. Keep the
// registry on globalThis so reconnects and stop requests keep finding the same
// runtime object. A registered stream is therefore expected to mean "active or
// reconnectable"; terminal paths must finish or dispose it so idle sessions disappear.
export class SessionStream {
  // ── Static registry and controls ─────────────────────────────────────

  private static readonly streams = sharedMap<SessionStream>("session-streams");

  static get(sessionId: string): SessionStream | undefined {
    return SessionStream.streams.get(sessionId);
  }

  /** @internal acquireSessionStream is the production caller. */
  static getOrCreate(
    sessionId: string,
    session: SessionConnection,
    initialState?: Partial<SessionState>,
  ): SessionStream {
    const existing = SessionStream.streams.get(sessionId);
    if (existing) {
      return existing;
    }

    const stream = new SessionStream(sessionId, session, initialState);
    SessionStream.streams.set(sessionId, stream);
    return stream;
  }

  static isRunning(sessionId: string): boolean {
    return SessionStream.streams.has(sessionId);
  }

  static async waitForCompletion(
    sessionId: string,
    timeoutMs?: number,
  ): Promise<SessionCompletion> {
    const stream = SessionStream.get(sessionId);
    if (!stream) {
      return completionResult((await loadSessionSnapshot(sessionId)).messages);
    }
    return stream.waitForCompletion(timeoutMs);
  }

  /**
   * Remove the live runtime as part of deleting its durable session.
   * Provider work is aborted and subscribers receive a terminal event, but a
   * deleted session publishes no idle/unread update. Completion waiters still
   * settle cleanly.
   */
  static async remove(sessionId: string): Promise<void> {
    const stream = SessionStream.streams.get(sessionId);
    if (!stream) return;
    await stream.removeForDeletion();
  }

  // ── Instance fields ──────────────────────────────────────────────────

  readonly sessionId: string;
  /** Underlying provider session used by runtime-owned operations. */
  readonly connection: SessionConnection;

  #bus = createSessionEventBus(MAX_REPLAY_EVENTS);

  readonly #completionWaiters = new Set<() => void>();
  #unsubscribeProvider: () => void;

  // Live session state survives turn boundaries; only replay history is
  // turn-scoped.
  #sessionState: SessionState;
  #activity: SessionActivity;

  // Claimed synchronously before #startTurn awaits so concurrent deliveries
  // cannot both open the stream's first turn.
  #hasOpenedTurn = false;
  #abortRequested = false;
  #finished = false;
  #completionResult: SessionCompletion | undefined;
  // Actions held for the owner's approval, by question request ID.
  readonly #approvals = new Map<string, (allowed: boolean) => void>();
  private constructor(
    sessionId: string,
    connection: SessionConnection,
    initialState?: Partial<SessionState>,
  ) {
    this.sessionId = sessionId;
    this.connection = connection;
    this.#sessionState = createInitialSessionState(initialState);
    this.#activity = createSessionActivity(this.#sessionState.usage?.aiCredits);

    this.#unsubscribeProvider = connection.onEvent((event) => this.#handleProviderEvent(event));
  }

  // ── Live stream surface ──────────────────────────────────────────────

  subscribe(
    afterEventId?: number,
    mode: SessionSubscriptionMode = "active",
  ): SessionStreamSubscription {
    return this.#bus.subscribe(afterEventId, mode);
  }

  /** Start the first message, or dispatch queued work when the assistant is ready. */
  async deliver(message: SessionMessage): Promise<MessageDisposition> {
    if (this.#finished || this.#abortRequested) {
      throw new SessionStreamFinishedError();
    }

    if (!this.#hasOpenedTurn) {
      this.#hasOpenedTurn = true;
      await this.#startTurn(deferMessage(message));
      return "started";
    }

    const isSubmittingMessage = this.#sessionState.queuedMessages.some(
      ({ status }) => status === "submitting",
    );
    const queuedMessage =
      message.immediate && isSubmittingMessage ? deferMessage(message) : message;

    if (queuedMessage.immediate) {
      await this.#submitMessage(queuedMessage);
      return "steered";
    }

    const coalesceKey = coalesceKeyForMessage(queuedMessage);
    if (
      !coalesceKey ||
      !this.#sessionState.queuedMessages.some(
        (queued) => coalesceKeyForMessage(queued) === coalesceKey,
      )
    ) {
      this.#emit({
        type: "message_queued",
        message: queuedMessage,
      });
    }

    if (this.#sessionState.status === "background") void this.#drainMessageQueue();
    return "queued";
  }

  async steerQueuedMessage(clientId: string): Promise<boolean> {
    if (
      this.#abortRequested ||
      this.#sessionState.queuedMessages.some(({ status }) => status === "submitting")
    ) {
      return false;
    }

    const message = this.#sessionState.queuedMessages.find(
      (candidate) => candidate.clientId === clientId,
    );
    if (message?.role !== "user" || message.status !== "queued") {
      return false;
    }

    await this.#submitMessage({ ...messageFromQueue(message), immediate: true });
    return true;
  }

  cancelQueuedMessage(clientId: string): boolean {
    if (this.#finished) return false;

    const message = this.#sessionState.queuedMessages.find(
      (candidate) => candidate.clientId === clientId,
    );
    if (!message || message.status !== "queued") {
      return false;
    }

    this.#emit({
      type: "message_cancelled",
      clientId,
    });

    return true;
  }

  async answerQuestion({
    requestId,
    answer,
    wasFreeform,
  }: SessionQuestionAnswer): Promise<boolean> {
    if (
      this.#finished ||
      this.#abortRequested ||
      !hasPendingSessionQuestion(this.#sessionState, requestId)
    ) {
      return false;
    }

    const approval = this.#approvals.get(requestId);
    if (approval) {
      this.#settleApproval(requestId, answer);
      approval(answer === APPROVAL_CHOICES[0]);
      return true;
    }
    return this.connection.answerQuestion({ requestId, answer, wasFreeform });
  }

  /**
   * Ask the owner to approve an action the host is holding. Approval rows are live-only; their
   * outcome reaches provider history as the action's result. Stopping the stream declines.
   */
  requestApproval(question: string, signal?: AbortSignal): Promise<boolean> {
    if (this.#finished || this.#abortRequested || signal?.aborted) return Promise.resolve(false);
    const requestId = `approval:${crypto.randomUUID()}`;
    const ask = { question, choices: [...APPROVAL_CHOICES], allowFreeform: false };
    return new Promise((resolve) => {
      const cancel = () => {
        if (!this.#approvals.has(requestId)) return;
        this.#settleApproval(requestId);
        resolve(false);
      };
      this.#approvals.set(requestId, (allowed) => {
        signal?.removeEventListener("abort", cancel);
        resolve(allowed);
      });
      signal?.addEventListener("abort", cancel, { once: true });
      this.#emit({
        type: "tool_start",
        toolCallId: requestId,
        toolName: "ask_user",
        arguments: {},
        question: ask,
      });
      this.#emit({ type: "question_requested", toolCallId: requestId, requestId, question: ask });
    });
  }

  /** Close an approval row with the owner's answer, or as unanswered when the action can't wait. */
  #settleApproval(requestId: string, answer?: string): void {
    this.#approvals.delete(requestId);
    if (this.#finished) return;
    this.#emit(
      answer === undefined
        ? { type: "question_cancelled", toolCallId: requestId }
        : { type: "question_resolved", toolCallId: requestId, answer },
    );
    this.#emit({
      type: "tool_end",
      toolCallId: requestId,
      success: true,
      result: answer ?? "Not answered",
    });
  }

  #declineApprovals(): void {
    for (const [requestId, resolve] of [...this.#approvals]) {
      this.#settleApproval(requestId);
      resolve(false);
    }
  }

  /** Wait for this stream instance to complete, not future replacements with the same ID. */
  waitForCompletion(timeoutMs?: number): Promise<SessionCompletion> {
    if (SessionStream.get(this.sessionId) !== this) {
      return Promise.resolve(
        this.#completionResult ?? completionResult(this.#sessionState.messages),
      );
    }

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (status: SessionCompletion["status"] = "completed") => {
        if (timer) clearTimeout(timer);
        this.#completionWaiters.delete(finish);
        resolve(this.#completionResult ?? completionResult(this.#sessionState.messages, status));
      };

      this.#completionWaiters.add(finish);

      if (timeoutMs !== undefined && timeoutMs >= 0) {
        timer = setTimeout(() => finish("timed_out"), timeoutMs);
      }
    });
  }

  getSessionState(): SessionState {
    return this.#sessionState;
  }

  // ── Stream controls ──────────────────────────────────────────────────

  /** @internal Complete this execution; external controls should abort or delete the session. */
  finish(reason: StreamEndReason = "idle", error?: string): void {
    if (this.#finished) return;
    this.#declineApprovals();
    this.#finished = true;
    this.#emit({ type: "end", reason, ...(error ? { error } : {}) });
    this.#completionResult = completionResult(
      this.#sessionState.messages,
      reason === "error" ? "failed" : "completed",
    );
    if (reason === "idle" && !this.#abortRequested) {
      cacheSnapshot(this.sessionId, this.#sessionState);
    }
    setSessionStatus(
      this.sessionId,
      this.#abortRequested || this.#bus.hasActiveSubscribers ? "idle" : "unread",
    );
    this.#bus.clearReplay();
    this.#dispose();
    releaseSession(this.sessionId);
  }

  /** Always finish the stream, even if the SDK abort itself fails. */
  async abort(): Promise<void> {
    this.#abortRequested = true;
    this.#declineApprovals();
    try {
      await this.connection.abort();
    } catch (error) {
      evictCachedSessionIfStale(this.sessionId, error);
      throw error;
    } finally {
      this.finish();
    }
  }

  private async removeForDeletion(): Promise<void> {
    this.#abortRequested = true;
    this.#declineApprovals();
    if (!this.#finished) this.#emit({ type: "end", reason: "idle" });
    this.#dispose();
    await this.connection.abort();
  }

  // ── Turn execution ───────────────────────────────────────────────────

  async #startTurn(message: SessionMessage): Promise<void> {
    this.#bus.clearReplay();
    this.#emit({ type: "status", status: "thinking" });

    try {
      if (message.role === "user" && message.model) {
        await this.#setModel(message.model);
      }

      await this.connection.send(message);
    } catch (error) {
      evictCachedSessionIfStale(this.sessionId, error);
      this.finish("error");
      throw error;
    }
  }

  async #setModel(configuration: ModelConfiguration): Promise<void> {
    if (this.#finished) return;

    if (areModelConfigurationsEqual(configuration, this.#sessionState.model)) {
      return;
    }

    await this.connection.setModel(configuration);
    this.#emit({
      type: "model_changed",
      model: configuration,
    });
  }

  // ── Provider event handling ───────────────────────────────────────────────

  #handleProviderEvent(event: SessionEvent): void {
    if (this.#finished) return;
    if (event.type === "session_title_changed") {
      broadcast({
        type: "session.upserted",
        session: { id: this.sessionId, title: event.title },
      });
      return;
    }
    if (event.type === "end") {
      if (event.reason === "error") {
        if (!this.#abortRequested) this.finish("error", event.error);
      } else {
        void this.#drainMessageQueue(true);
      }
      return;
    }
    this.#emit(event);
    if (this.#sessionState.status === "background") void this.#drainMessageQueue();
  }

  async #drainMessageQueue(finishWhenEmpty = false): Promise<void> {
    if (
      this.#abortRequested ||
      this.#finished ||
      this.#sessionState.queuedMessages.some(({ status }) => status === "submitting") ||
      hasBlockingSessionQuestion(this.#sessionState)
    ) {
      return;
    }

    const queuedMessage = this.#sessionState.queuedMessages[0];
    if (!queuedMessage) {
      if (finishWhenEmpty) this.finish();
      return;
    }
    if (queuedMessage.status !== "queued") return;

    try {
      await this.#submitMessage(messageFromQueue(queuedMessage));
    } catch {
      // #startTurn already finished the stream; this runs from a floating SDK handler.
    }
  }

  // ── Event emission ───────────────────────────────────────────────────

  #emit(event: SessionEvent): void {
    const published = this.#bus.publish(event);
    this.#sessionState = applySessionEvent(this.#sessionState, published);
    this.#recordActivity(published);
    if (
      published.type === "status" ||
      published.type === "question_requested" ||
      published.type === "question_resolved" ||
      published.type === "question_cancelled"
    ) {
      const status = this.#sessionState.status === "background" ? "background" : "running";
      setSessionStatus(
        this.sessionId,
        hasBlockingSessionQuestion(this.#sessionState) ? "waiting" : status,
      );
    }
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  /** A process that stops mid-turn loses only the busy time since that turn's latest report. */
  #recordActivity(event: SessionEvent): void {
    const { activity, hours } = observeActivity(this.#activity, event, Date.now());
    this.#activity = activity;
    if (hours.length === 0) return;
    recordSessionActivity(this.sessionId, hours).catch((error) =>
      console.error(`Could not record activity for session ${this.sessionId}:`, error),
    );
  }

  async #submitMessage(message: SessionMessage): Promise<void> {
    this.#emit({ type: "message_queued", message });
    this.#emit({
      type: "message_status_changed",
      clientId: message.clientId,
      status: "submitting",
    });
    try {
      if (message.immediate) {
        await this.connection.send(message);
      } else {
        await this.#startTurn(message);
      }
      this.#emit({
        type: "message_status_changed",
        clientId: message.clientId,
        status: "submitted",
      });
    } catch (error) {
      if (
        message.immediate &&
        !this.#abortRequested &&
        this.#sessionState.queuedMessages.some(
          ({ clientId: candidateId }) => candidateId === message.clientId,
        )
      ) {
        this.#emit({
          type: "message_queued",
          message: deferMessage(message),
        });
      }
      throw error;
    } finally {
      if (this.#sessionState.status === "background") void this.#drainMessageQueue();
    }
  }

  updateArtifacts(artifacts: SessionArtifact[]): void {
    if (this.#finished) return;
    this.#emit({ type: "artifacts_changed", artifacts });
  }

  #dispose(): void {
    // Session deletion can dispose without the domain finish transition. Mark
    // the stream finished so a stale reference cannot emit a terminal event or
    // accept a message after registry removal.
    this.#finished = true;

    this.#bus.close();
    for (const resolve of this.#completionWaiters) resolve();
    this.#unsubscribeProvider();
    SessionStream.streams.delete(this.sessionId);
  }
}

export class SessionStreamFinishedError extends Error {
  constructor() {
    super("Session stream finished before the message could be delivered.");
  }
}

function coalesceKeyForMessage(message: SessionMessage): string | undefined {
  return message.role === "system" ? systemMessageCoalesceKey(message.content) : undefined;
}

function messageFromQueue(message: SessionState["queuedMessages"][number]): SessionMessage {
  const { status: _status, ...sessionMessage } = message;
  return sessionMessage;
}

function deferMessage(message: SessionMessage): SessionMessage {
  const { immediate: _immediate, ...deferred } = message;
  return deferred;
}

function completionResult(
  messages: SessionState["messages"],
  status: SessionCompletion["status"] = "completed",
): SessionCompletion {
  const lastMessage = messages.at(-1);
  const error =
    status === "failed" && lastMessage?.role === "assistant" ? lastMessage.error : undefined;
  const result = { status, ...(error ? { error } : {}) };
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "assistant" && message.content.trim().length > 0) {
      return { ...result, response: message.content };
    }
  }

  return result;
}
