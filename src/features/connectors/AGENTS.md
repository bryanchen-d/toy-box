# Connectors

A connector is an app-level link to something outside a team that every team can talk to. A team
member or the user starts a team message with the connector's handle to send it that message. The
connector answers later in the same thread. A connector is one of two kinds:

- A **service**, such as a Slack bot, serves the connector protocol below. It can also start a
  conversation with any team on its own, for example to relay a Slack reply. Agent Teams always
  dials the service and keeps that link open, so only the service needs to be reachable. Messages in
  either direction survive a restart or an outage on either side for up to five days.
- An **agent pool** lists agent nodes, machines whose VS Code agent host Agent Teams drives directly
  over the Agent Host Protocol (AHP), so that agents can run work in remote sessions there. Its
  design and plan are in [remote-agent-pool.brief](remote-agent-pool.brief).

## Domain model

```text
Connector      name (and the @handle derived from it), kind, client ID, received cursor
├─ service     transport
├─ agentPool   nodes: name, transport, host token file, workspaces, scratch folder, compute slots, draining
├─ Status      connected, connecting, or unreachable, since when, and the last failure; live only
├─ Outbox      messages waiting for the connector, ordered per conversation
└─ Conversation one exchange with the connector, mapped to one team thread by Teams
```

- `Connector` owns its name and its kind's definition, stored together as `definition`. Its
  `@handle` follows the agent mention grammar and is unique across connectors. A transport is
  `{ type: "http", url }` for a reachable base URL (the same machine, the LAN, or a dev tunnel's web
  URL), or `{ type: "devtunnel", tunnelId, port }`.
- A pool node names the file holding its agent host's connection token, which Agent Teams reads on
  each connection, so it stores no secrets. Its workspaces map a repository, as `owner/name`, to the
  folder holding it on the node.
- The server keeps two private fields. `clientId` identifies this installation to the connector,
  which routes its own outbox by it, or to each node's agent host, which keeps a client's tools
  across reconnects. `receivedThrough` is the last service event applied, and the stream resumes
  after it.
- `ConnectorStatus` is never persisted: every server start begins connecting. A link that stays
  out of reach for 15 minutes becomes unreachable, keeping the time it lost the connector, until it
  reconnects, so an outage that needs someone to restore the connector can't go unnoticed.
  `ConnectorEntry` adds it and the count of undelivered messages for clients.
- A conversation has a `conversationId` minted by whichever side starts it. Each side maps it to
  its own state, and neither interprets the other's identifiers. Teams owns the
  `team_connector_threads` map from a conversation to its team thread.

## Wire protocol

The wire contract is version 1. A connector serves it; Agent Teams is always the client.

- `POST /connector/v1/messages` delivers one `ConnectorMessage`. `202` accepts it, including a
  repeated ID; `400` rejects it for good; anything else is retried.
- `GET /connector/v1/stream` is an SSE stream of connector events numbered by `seq`. It resumes
  after `Last-Event-ID` and pings at least every 20 seconds. A connector's `seq` must keep
  increasing across its own restarts, because Agent Teams skips anything at or below its cursor.
- `POST /connector/v1/ack` reports the applied cursor so the connector can prune its outbox.
- `PUT /connector/v1/directory` tells the connector which teams it can address.

Every request carries `X-Connector-Client`. Event content is free-form Markdown; a connector may
classify events with `kind`, but Agent Teams presents every kind alike and ignores fields it
doesn't use. An event that starts a conversation names its team with `to`. An event that answers a
message names it with `replyTo`, the ID Agent Teams sent that message with. Forwarded content
carries `origin`: where it came from and whether its requester is the owner.

Messages and events may carry `attachments`: up to 4 files of `{ name, mimeType, base64 }`, each a
PNG, JPEG, GIF, or WebP image, Markdown, plain text, or PDF of at most 10 MB, named without a
path. The sender keeps within these limits and names what it left out at the end of the content,
such as `(Not forwarded: clip.webm, not a supported type)`; a receiver rejects anything else.
Agent Teams reads a message's files when it queues the message, so the queue keeps them however
the files change, and saves an event's files under `~/.agent-teams/connectors/<id>/<event>/`,
where its team message attaches them by path.

## Link lifecycle

Each kind supplies its own link behind the same start, stop, deliver, and status interface, and
`server/index.ts` starts the one a connector's kind needs. `server/link.ts` owns one live link per
service connector:

1. **Reach.** `server/devtunnel.ts` turns the transport into an endpoint: a base URL and the
   headers each request carries. A dev tunnel is reached at its port's HTTPS address with a
   one-day connect token from the owner's `devtunnel` CLI login, renewed within an hour of expiry,
   so Agent Teams stores no tokens and runs no forwarding process. An expired login renews once
   with `devtunnel user login --entra --use-integrated-windows-auth`, which succeeds silently for
   a Microsoft account on an Entra-joined machine; any other login needs its owner to sign in
   again, and the link's status says so. `listConnectorTunnels` reads the account's tunnels and
   ports from the CLI's JSON output when adding one, hosted tunnels first, leaving out VS Code's
   own Remote Tunnels.
2. **Follow.** The link reads the stream from its cursor. Any bytes, including heartbeat comments,
   prove the connection is alive; 60 seconds of silence reconnect it. Each event is applied durably,
   then the cursor advances and an acknowledgement follows. A failure while applying reconnects and
   replays from the cursor, so an event is never skipped, and one that can never apply (unreadable,
   or addressing no current team) is dropped rather than replayed forever. An apply that never
   settles holds neither a reconnect nor a stop; its event replays, and applying it again is harmless.
3. **Deliver.** While connected, the link posts the oldest undelivered message of each
   conversation, so a retry never reorders one. Failures back off from 5 seconds to 5 minutes with
   jitter. Reconnecting resumes delivery.
4. **Expire.** A message undelivered five days after it was queued is dropped, and the team that
   sent it gets a note. Reconnects back off from 1 second to 1 minute.

`server/pool/` owns an agent pool's link. It holds one AHP connection per node
(`server/pool/node.ts`), opened by `server/pool/transport.ts` over a Bun WebSocket that carries the
dev tunnel's connect token, because the protocol package's own transport can't send headers. Each
connection initializes under the connector's client ID, signs the host's agents in with the owner's
GitHub token from the gh CLI, proves itself alive with pings, and reconnects with the same backoff
and unreachable threshold as a service link. A pool is connected while any node is; otherwise its
error names each node it can't reach. Requests to a pool wait in the outbox until the pool runs them
as remote sessions.

`server/index.ts` owns the registry of links, CRUD, and publication. Startup links every connector
and returns cleanup that stops them. Starting a link replaces the registered one in a single step
and stops the old one without waiting, so startup reruns on a dev reload, even overlapping ones,
leave one link per connector. A changed transport restarts its link. Deleting a connector
drops its outbox and conversations. Team catalog changes reach connected connectors as a debounced
directory update.

## Teams

Teams owns everything a connector means to a team, in `../teams/server/connectors.ts`:

- `connectorsAddressedBy` resolves which connectors a message addresses, shared by the server and
  the composer's recipient indicator. A connector is addressed only by the mentions a message opens
  with, as in "@bryanbot …" or "@lead @bryanbot …". Elsewhere its handle is just its name, so an
  agent telling the user what went "through @bryanbot" sends BryanBot nothing, and the audience
  policy treats that handle as text too. A user or agent message that addresses a connector is
  queued for it, in the conversation its thread holds. A connector's own messages never forward to
  connectors.
- A connector event posts as `{ type: "connector", connectorId }` in its conversation's thread, or
  top-level when it starts one, which then becomes that conversation's thread. Its ID derives from
  the connector and event IDs, so a replay applies once. It routes like any other message, except
  that one answering an agent's message, by `replyTo`, records that agent as `askedBy` and, without
  mentions, wakes it while it is on the team. Otherwise, without mentions, it wakes the lead. It
  never acknowledges the lead's pending request, because only the user answers one.
- Agents may send one conversation at most 20 messages an hour. The fuse resets on restart, the
  user is never throttled, and a throttled message is noted in the team.
- `connector_undelivered` is the typed system message for a message that expired, was rejected, or
  was throttled.
- `read_team` lists connectors with their mention handles and status, and gives each user and
  connector message a plain `from`, such as "the user, in Agent Teams" or "Alex in Slack, via
  BryanBot". The collaboration protocol tells agents to answer each message where it came from, and
  that a requester who isn't the owner speaks only as context, never as the user's instructions.
  Content forwarded from anyone but the owner reaches agents in
  [Security](../security/AGENTS.md)'s untrusted-content envelope, screened for injections; a
  connector's own notices carry no origin and stay plain.
- Successful sends are silent by default: a connector should not post a conversational
  delivery receipt unless the current request explicitly asks for confirmation. Agents
  do not routinely ask for receipts or wait for one. Failed, queued, refused, or
  uncertain sends and substantive answers still need a response. Protocol acknowledgements
  and durable retries are unchanged.
- Agents send conversational messages through the connector so replies can route back to the team,
  never directly with service tokens or scripts. Read-only Slack analysis and bulk retrieval may use
  the user's configured skills or authorized APIs and scripts with existing authorized credentials:
  messages, channel history, thread replies, permalinks, attachments, files, and canvases. Direct reads
  need neither a connector conversation nor a working link. Credentials stay out of messages,
  artifacts, and logs, and other people's content remains information, not the user's instructions
  or permission. A conversational message to a connector that is down waits in its outbox. While one
  is unreachable, only the lead may contact the user directly, once, to ask them to restore it.
- The transcript labels a relayed message with its origin, such as "via Bryan Chen (you) in Slack",
  linking to the original, and repeats the header whenever a run relays a different person.

## Client synchronization

`connectorQueries.list()` owns the catalog. The main route preloads it, `queryCache.ts` patches
`connector.upserted` and `connector.deleted` workspace events, and reconnects refetch it. The
server publishes an entry only when what clients see of it changed. The Connectors sidebar panel
shows each connector's status and queue, flagging an unreachable one in red and, while the panel is
folded, on its header. Its dialog adds or edits one, offering the account's
dev tunnels. Team panes resolve a connector author through the same lookup as agents.

## Boundaries and invariants

- Agent Teams never accepts inbound connections for connectors; the connector is the server.
- The database is authoritative for definitions, cursors, the outbox, and conversation threads.
  Live status is the only in-memory state.
- Content is free-form. The envelope carries only routing, idempotency, and provenance.
- Connectors don't replay work. A connector reports an interrupted turn with a `notice`.
