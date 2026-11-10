// One live link to one connector: it follows the connector's event stream and drains this
// installation's outbox into it. Agent Teams always dials; the connector never dials in.

import { EventSourceParserStream } from "eventsource-parser/stream";
import type { EventSourceMessage } from "eventsource-parser";
import {
  backoffDelay,
  CONNECTOR_MESSAGE_TTL_MS,
  CONNECTOR_PROTOCOL_VERSION,
  connectorEventSchema,
  DELIVERY_BACKOFF,
  RECONNECT_BACKOFF,
  type Connector,
  type ConnectorEvent,
  type ConnectorMessage,
  type ConnectorStatus,
  type ConnectorTransport,
} from "../model";
import type { ConnectorDatabase, ConnectorRecord, PendingConnectorMessage } from "./database";

/** A reachable base URL for a connector, and how to release whatever made it reachable. */
export type ConnectorEndpoint = { baseUrl: string; dispose: () => void };

/** A team the connector may start a conversation with. */
export type ConnectorDirectoryTeam = { id: string; name: string; purpose?: string };

export type ConnectorLinkDependencies = {
  database: ConnectorDatabase;
  openEndpoint: (transport: ConnectorTransport, signal: AbortSignal) => Promise<ConnectorEndpoint>;
  /** Applies one event durably. Throwing reconnects and replays it; returning drops nothing. */
  applyEvent: (connector: Connector, event: ConnectorEvent) => Promise<void>;
  noteUndelivered: (
    connector: Connector,
    message: ConnectorMessage,
    reason: "expired" | "rejected",
  ) => Promise<void>;
  readDirectory: () => Promise<ConnectorDirectoryTeam[]>;
  /** The link's status or pending count changed. */
  onChange: (connectorId: string) => void;
  fetch?: typeof fetch;
  now?: () => Date;
  timing?: Partial<typeof DEFAULT_TIMING>;
};

const DEFAULT_TIMING = {
  /** A connector pings at least every 20 seconds; three missed pings mean the link is dead. */
  heartbeatTimeoutMs: 60_000,
  ackDelayMs: 500,
  requestTimeoutMs: 30_000,
  expirySweepMs: 60 * 60_000,
  /** Even with nothing due, re-check the outbox so a lost timer can't strand a message. */
  maxDeliveryWaitMs: 5 * 60_000,
  /** Out of reach this long, a connector needs someone to restore it rather than another retry. */
  unreachableAfterMs: 15 * 60_000,
  reconnectBackoff: RECONNECT_BACKOFF,
  deliveryBackoff: DELIVERY_BACKOFF,
};

export class ConnectorLink {
  readonly #deps: Required<Omit<ConnectorLinkDependencies, "timing">>;
  readonly #timing: typeof DEFAULT_TIMING;
  readonly #abort = new AbortController();
  #connector: ConnectorRecord;
  #receivedThrough: number;
  #status: ConnectorStatus;
  #baseUrl: string | undefined;
  #failures = 0;
  #running: Promise<void> | undefined;
  #delivering = false;
  #deliverAgain = false;
  #deliveryTimer: ReturnType<typeof setTimeout> | undefined;
  #expiryTimer: ReturnType<typeof setInterval> | undefined;
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #unreachableTimer: ReturnType<typeof setTimeout> | undefined;
  #directory: string | undefined;

  constructor(connector: ConnectorRecord, dependencies: ConnectorLinkDependencies) {
    this.#connector = connector;
    this.#receivedThrough = connector.receivedThrough;
    this.#deps = { fetch, now: () => new Date(), ...dependencies };
    this.#timing = { ...DEFAULT_TIMING, ...dependencies.timing };
    this.#status = { state: "connecting", since: this.#deps.now().toISOString() };
  }

  get status(): ConnectorStatus {
    return this.#status;
  }

  start(): void {
    this.#running ??= this.#follow();
    this.#expiryTimer = setInterval(() => void this.deliver(), this.#timing.expirySweepMs);
    this.#expiryTimer.unref?.();
    this.#watchReachability();
    void this.deliver();
  }

  async stop(): Promise<void> {
    this.#abort.abort();
    clearTimeout(this.#deliveryTimer);
    clearInterval(this.#expiryTimer);
    clearTimeout(this.#ackTimer);
    clearTimeout(this.#unreachableTimer);
    await this.#running;
  }

  /** Delivers whatever is due now, then waits for the next retry. */
  async deliver(): Promise<void> {
    if (this.#delivering) {
      this.#deliverAgain = true;
      return;
    }
    this.#delivering = true;
    try {
      do {
        this.#deliverAgain = false;
        await this.#expire();
        await this.#deliverDue();
      } while (this.#deliverAgain && !this.#abort.signal.aborted);
    } catch (error) {
      console.error(`Failed to deliver to connector ${this.#connector.name}:`, error);
    } finally {
      this.#delivering = false;
    }
    this.#deps.onChange(this.#connector.id);
    await this.#scheduleDelivery();
  }

  /** Tells the connector which teams it can address, when that list changed. */
  async syncDirectory(): Promise<void> {
    const baseUrl = this.#baseUrl;
    if (!baseUrl) return;
    const body = JSON.stringify({
      version: CONNECTOR_PROTOCOL_VERSION,
      teams: await this.#deps.readDirectory(),
    });
    if (body === this.#directory) return;
    try {
      const response = await this.#request(baseUrl, "directory", { method: "PUT", body });
      if (response.ok) this.#directory = body;
    } catch {
      // The next connection sends the directory again.
    }
  }

  async #follow(): Promise<void> {
    const signal = this.#abort.signal;
    while (!signal.aborted) {
      let endpoint: ConnectorEndpoint | undefined;
      try {
        endpoint = await this.#deps.openEndpoint(this.#connector.transport, signal);
        await this.#observe(endpoint.baseUrl);
      } catch (error) {
        if (signal.aborted) break;
        this.#disconnected(error);
      } finally {
        endpoint?.dispose();
      }
      await sleep(backoffDelay(this.#failures, this.#timing.reconnectBackoff), signal);
    }
  }

  /** Follows one stream until it fails or the link stops. */
  async #observe(baseUrl: string): Promise<void> {
    const attempt = new AbortController();
    const stopAttempt = () => attempt.abort(this.#abort.signal.reason);
    this.#abort.signal.addEventListener("abort", stopAttempt, { once: true });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const expectHeartbeat = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(
        () => attempt.abort(new Error("The connector stopped sending heartbeats.")),
        this.#timing.heartbeatTimeoutMs,
      );
    };

    try {
      expectHeartbeat();
      const response = await this.#deps.fetch(connectorUrl(baseUrl, "stream"), {
        headers: {
          ...this.#headers(),
          Accept: "text/event-stream",
          "Last-Event-ID": String(this.#receivedThrough),
        },
        signal: attempt.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`The connector refused the stream (HTTP ${response.status}).`);
      }

      this.#connected(baseUrl);
      const events = response.body
        .pipeThrough(
          new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
            transform(chunk, controller) {
              // Any bytes, including heartbeat comments, prove the connection is alive.
              expectHeartbeat();
              controller.enqueue(chunk);
            },
          }),
        )
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream());
      for await (const message of events) await this.#receive(message);
      throw new Error("The connector closed its stream.");
    } catch (error) {
      throw attempt.signal.reason instanceof Error ? attempt.signal.reason : error;
    } finally {
      clearTimeout(watchdog);
      this.#abort.signal.removeEventListener("abort", stopAttempt);
      attempt.abort();
      this.#baseUrl = undefined;
    }
  }

  async #receive(message: EventSourceMessage): Promise<void> {
    if (message.event && message.event !== "message") return;
    const sequence = Number(message.id);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      console.warn(`Ignoring connector ${this.#connector.name} event without a sequence.`);
      return;
    }
    if (sequence <= this.#receivedThrough) return;

    const event = parseEvent(message.data);
    if (event) await this.#deps.applyEvent(this.#connector, event);
    else
      console.error(`Dropping invalid event ${sequence} from connector ${this.#connector.name}.`);
    await this.#deps.database.advanceReceivedThrough(this.#connector.id, sequence);
    this.#receivedThrough = sequence;
    this.#scheduleAck();
  }

  #connected(baseUrl: string): void {
    this.#baseUrl = baseUrl;
    this.#failures = 0;
    this.#directory = undefined;
    clearTimeout(this.#unreachableTimer);
    this.#setStatus({ state: "connected", since: this.#deps.now().toISOString() });
    void this.syncDirectory();
    void this.deliver();
    if (this.#receivedThrough > 0) this.#scheduleAck();
  }

  #disconnected(error: unknown): void {
    this.#failures++;
    const status = this.#status;
    if (status.state !== "connected") {
      this.#setStatus({ ...status, error: errorMessage(error) });
      return;
    }
    this.#setStatus({
      state: "connecting",
      since: this.#deps.now().toISOString(),
      error: errorMessage(error),
    });
    this.#watchReachability();
  }

  /** Reports the connector unreachable if this attempt to reach it outlasts the threshold. */
  #watchReachability(): void {
    clearTimeout(this.#unreachableTimer);
    this.#unreachableTimer = setTimeout(() => {
      const status = this.#status;
      if (status.state === "connecting") this.#setStatus({ ...status, state: "unreachable" });
    }, this.#timing.unreachableAfterMs);
    this.#unreachableTimer.unref?.();
  }

  #setStatus(status: ConnectorStatus): void {
    const previous = this.#status;
    this.#status = status;
    if (
      previous.state !== status.state ||
      previous.since !== status.since ||
      ("error" in previous ? previous.error : undefined) !==
        ("error" in status ? status.error : undefined)
    ) {
      this.#deps.onChange(this.#connector.id);
    }
  }

  #scheduleAck(): void {
    if (this.#ackTimer) return;
    this.#ackTimer = setTimeout(() => {
      this.#ackTimer = undefined;
      void this.#acknowledge();
    }, this.#timing.ackDelayMs);
  }

  async #acknowledge(): Promise<void> {
    const baseUrl = this.#baseUrl;
    if (!baseUrl) return;
    try {
      await this.#request(baseUrl, "ack", {
        method: "POST",
        body: JSON.stringify({
          version: CONNECTOR_PROTOCOL_VERSION,
          through: this.#receivedThrough,
        }),
      });
    } catch {
      // Resuming from the stored cursor never replays applied events, so only pruning waits.
    }
  }

  async #deliverDue(): Promise<void> {
    for (;;) {
      const baseUrl = this.#baseUrl;
      if (!baseUrl || this.#abort.signal.aborted) return;
      const due = await this.#deps.database.dueMessages(this.#connector.id, this.#deps.now());
      if (due.length === 0) return;
      let progressed = false;
      for (const pending of due) {
        if (this.#baseUrl !== baseUrl) return;
        if (await this.#post(baseUrl, pending)) progressed = true;
      }
      if (!progressed) return;
    }
  }

  /** Returns whether the message left the outbox. */
  async #post(baseUrl: string, pending: PendingConnectorMessage): Promise<boolean> {
    const { database } = this.#deps;
    try {
      const response = await this.#request(baseUrl, "messages", {
        method: "POST",
        body: JSON.stringify(pending.message),
      });
      if (response.ok) {
        await database.remove(this.#connector.id, pending.id);
        return true;
      }
      const detail = await response.text().catch(() => "");
      if (response.status === 400) {
        await database.remove(this.#connector.id, pending.id);
        await this.#deps.noteUndelivered(this.#connector, pending.message, "rejected");
        return true;
      }
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    } catch (error) {
      if (this.#abort.signal.aborted) return false;
      const delay = backoffDelay(pending.attempts + 1, this.#timing.deliveryBackoff);
      await database.recordFailure(
        this.#connector.id,
        pending.id,
        errorMessage(error),
        new Date(this.#deps.now().getTime() + delay),
      );
      return false;
    }
  }

  async #expire(): Promise<void> {
    const cutoff = new Date(this.#deps.now().getTime() - CONNECTOR_MESSAGE_TTL_MS);
    for (const expired of await this.#deps.database.takeExpired(this.#connector.id, cutoff)) {
      await this.#deps
        .noteUndelivered(this.#connector, expired.message, "expired")
        .catch((error) => console.error("Failed to note an expired connector message:", error));
    }
  }

  async #scheduleDelivery(): Promise<void> {
    clearTimeout(this.#deliveryTimer);
    this.#deliveryTimer = undefined;
    if (this.#abort.signal.aborted || !this.#baseUrl) return;
    const next = await this.#deps.database.nextAttemptAt(this.#connector.id);
    if (!next) return;
    const wait = Math.min(
      this.#timing.maxDeliveryWaitMs,
      Math.max(0, Date.parse(next) - this.#deps.now().getTime()),
    );
    this.#deliveryTimer = setTimeout(() => void this.deliver(), wait);
    this.#deliveryTimer.unref?.();
  }

  #request(baseUrl: string, path: string, init: RequestInit): Promise<Response> {
    return this.#deps.fetch(connectorUrl(baseUrl, path), {
      ...init,
      headers: { ...this.#headers(), "Content-Type": "application/json" },
      signal: AbortSignal.any([
        this.#abort.signal,
        AbortSignal.timeout(this.#timing.requestTimeoutMs),
      ]),
    });
  }

  #headers(): Record<string, string> {
    // A private dev tunnel otherwise answers some requests with its browser interstitial.
    return {
      "X-Connector-Client": this.#connector.clientId,
      "X-Tunnel-Skip-AntiPhishing-Page": "1",
    };
  }
}

function connectorUrl(baseUrl: string, path: string): URL {
  return new URL(`connector/v1/${path}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
}

function parseEvent(data: string): ConnectorEvent | undefined {
  try {
    return connectorEventSchema.parse(JSON.parse(data));
  } catch {
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
