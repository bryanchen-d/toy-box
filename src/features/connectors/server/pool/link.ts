// A pool connector's live link: one connection per node, and the pool's status derived from them.

import type { AhpTransport } from "@microsoft/agent-host-protocol/client";
import type { ConnectorStatus, PoolNode } from "../../model";
import type { AgentPoolConnectorRecord } from "../database";
import { NodeLink, type NodeLinkDependencies } from "./node";

export type PoolLinkDependencies = {
  openTransport: (node: PoolNode) => Promise<AhpTransport>;
  githubToken: () => Promise<string>;
  /** The link's status changed. */
  onChange: (connectorId: string) => void;
  now?: () => Date;
  timing?: NodeLinkDependencies["timing"];
};

export class PoolLink {
  readonly #nodes: NodeLink[];

  constructor(connector: AgentPoolConnectorRecord, dependencies: PoolLinkDependencies) {
    this.#nodes = connector.nodes.map(
      (node) =>
        new NodeLink(node, {
          clientId: connector.clientId,
          openTransport: dependencies.openTransport,
          githubToken: dependencies.githubToken,
          onChange: () => dependencies.onChange(connector.id),
          now: dependencies.now,
          timing: dependencies.timing,
        }),
    );
  }

  get status(): ConnectorStatus {
    return poolStatus(this.#nodes.map(({ node, status }) => ({ name: node.name, status })));
  }

  start(): void {
    for (const node of this.#nodes) node.start();
  }

  async stop(): Promise<void> {
    await Promise.all(this.#nodes.map((node) => node.stop()));
  }

  /** Requests wait in the outbox until the pool runs them as remote sessions. */
  async deliver(): Promise<void> {}

  /** A pool answers only the teams that write to it, so it needs no directory. */
  async syncDirectory(): Promise<void> {}
}

/**
 * A pool is connected while any node is. Otherwise it is unreachable once every node is, since
 * the last one was lost, and its error names each node it can't reach.
 */
export function poolStatus(nodes: { name: string; status: ConnectorStatus }[]): ConnectorStatus {
  const connected = nodes.filter(({ status }) => status.state === "connected");
  if (connected.length) {
    return { state: "connected", since: earliest(connected.map(({ status }) => status.since)) };
  }
  const errors = nodes.flatMap(({ name, status }) =>
    status.state !== "connected" && status.error ? [`${name}: ${status.error}`] : [],
  );
  return {
    state: nodes.every(({ status }) => status.state === "unreachable")
      ? "unreachable"
      : "connecting",
    since: latest(nodes.map(({ status }) => status.since)),
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}

function earliest(times: string[]): string {
  return times.reduce((first, time) => (time < first ? time : first));
}

function latest(times: string[]): string {
  return times.reduce((last, time) => (time > last ? time : last));
}
