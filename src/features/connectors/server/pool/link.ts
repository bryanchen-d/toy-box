// A pool connector's live link: one connection per node, and the pool's status derived from them.

import type { ConnectorStatus } from "../../model";
import type { AgentPoolConnectorRecord } from "../database";
import { NodeLink, type NodeLinkDependencies } from "./node";

export type PoolLinkDependencies = {
  openTransport: NodeLinkDependencies["openTransport"];
  /** The agent host each node's sessions live on, kept across restarts. */
  hosts: {
    read: (node: string) => Promise<string | undefined>;
    remember: (node: string, host: string) => Promise<void>;
  };
  githubToken: () => Promise<string>;
  /** Runs sessions on a node while the pool lists it; the returned function stops that. */
  serveNode: (node: NodeLink) => () => void;
  /** The link's status changed. */
  onChange: (connectorId: string) => void;
  now?: () => Date;
  timing?: NodeLinkDependencies["timing"];
};

export class PoolLink {
  readonly #nodes: NodeLink[];
  readonly #serveNode: PoolLinkDependencies["serveNode"];
  #stopServing: (() => void)[] = [];

  constructor(connector: AgentPoolConnectorRecord, dependencies: PoolLinkDependencies) {
    this.#serveNode = dependencies.serveNode;
    this.#nodes = connector.nodes.map(
      (node) =>
        new NodeLink(node, {
          clientId: connector.clientId,
          openTransport: dependencies.openTransport,
          hosts: {
            read: () => dependencies.hosts.read(node.name),
            remember: (host) => dependencies.hosts.remember(node.name, host),
          },
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

  /** Each node's connection state, by node name. */
  get nodeStates(): Record<string, ConnectorStatus["state"]> {
    return Object.fromEntries(this.#nodes.map(({ node, status }) => [node.name, status.state]));
  }

  start(): void {
    for (const node of this.#nodes) node.start();
    this.#stopServing = this.#nodes.map((node) => this.#serveNode(node));
  }

  async stop(): Promise<void> {
    for (const stopServing of this.#stopServing) stopServing();
    await Promise.all(this.#nodes.map((node) => node.stop()));
  }

  /** No message addresses a pool, so it never has anything to deliver. */
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
