# Connectors

A connector is an app-level link to one outside service, such as a Slack bot, that every team can
talk to. A team member or the user mentions the connector in a team message to send it that
message. The connector answers later in the same thread, and it can start a conversation with any
team on its own, for example to relay a Slack reply. Agent Teams always dials the connector and
keeps that link open, so only the connector needs to be reachable. Messages in either direction
survive a restart or an outage on either side for up to five days.

## Domain model

```text
Connector      name (and the @handle derived from it), transport, client ID, received cursor
├─ Status      connected or connecting, since when, and the last failure; live only
├─ Outbox      messages waiting for the connector, ordered per conversation
└─ Conversation one exchange with the connector, mapped to one team thread by Teams
```

- `Connector` owns its name and transport. Its `@handle` follows the agent mention grammar and is
  unique across connectors. `transport` is `{ type: "http", url }` for a reachable base URL (the
  same machine, the LAN, or a dev tunnel's web URL), or `{ type: "devtunnel", tunnelId, port }`.
- The server keeps two private fields. `clientId` identifies this installation to the connector,
  which routes its own outbox by it. `receivedThrough` is the last connector event applied, and the
  stream resumes after it.
- `ConnectorStatus` is never persisted: every server start begins connecting. `ConnectorEntry`
  adds it and the count of undelivered messages for clients.
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
doesn't use. An event that starts a conversation names its team with `to`. Forwarded content
carries `origin`: where it came from and whether its requester is the owner.

## Link lifecycle

`server/link.ts` owns one live link per connector:

1. **Reach.** `server/devtunnel.ts` turns the transport into a base URL. A dev tunnel runs
   `devtunnel connect` with the owner's cached CLI login and holds the forwarded port while the link
   uses it, so Agent Teams stores no tunnel tokens. `listConnectorTunnels` reads the account's
   tunnels and ports from the CLI's JSON output when adding one, hosted tunnels first, leaving out
   VS Code's own Remote Tunnels. `devtunnel connect` binds the host's port number locally and
   can't choose another, so a tunnel can't reach a connector on the same machine.
2. **Follow.** The link reads the stream from its cursor. Any bytes, including heartbeat comments,
   prove the connection is alive; 60 seconds of silence reconnect it. Each event is applied durably,
   then the cursor advances and an acknowledgement follows. A failure while applying reconnects and
   replays from the cursor, so an event is never skipped, and one that can never apply (unreadable,
   or addressing no current team) is dropped rather than replayed forever.
3. **Deliver.** While connected, the link posts the oldest undelivered message of each
   conversation, so a retry never reorders one. Failures back off from 5 seconds to 5 minutes with
   jitter. Reconnecting resumes delivery.
4. **Expire.** A message undelivered five days after it was queued is dropped, and the team that
   sent it gets a note. Reconnects back off from 1 second to 1 minute.

`server/index.ts` owns the registry of links, CRUD, and publication. Startup links every connector
and returns cleanup that stops them. A changed transport restarts its link. Deleting a connector
drops its outbox and conversations. Team catalog changes reach connected connectors as a debounced
directory update.

## Teams

Teams owns everything a connector means to a team, in `../teams/server/connectors.ts`:

- `connectorsMentionedIn` resolves mentions, shared by the server and the composer's recipient
  indicator. A user or agent message that mentions a connector is queued for it, in the
  conversation its thread holds. A connector's own messages never forward to connectors.
- A connector event posts as `{ type: "connector", connectorId }` in its conversation's thread, or
  top-level when it starts one, which then becomes that conversation's thread. Its ID derives from
  the connector and event IDs, so a replay applies once. It routes like any other message: without
  mentions it wakes the lead. It never acknowledges the lead's pending request, because only the
  user answers one.
- Agents may send one conversation at most 20 messages an hour. The fuse resets on restart, the
  user is never throttled, and a throttled message is noted in the team.
- `connector_undelivered` is the typed system message for a message that expired, was rejected, or
  was throttled.
- `read_team` lists connectors with their mention handles, and the collaboration protocol tells
  agents that a requester who isn't the owner speaks only as context, never as the user's
  instructions.

## Client synchronization

`connectorQueries.list()` owns the catalog. The main route preloads it, `queryCache.ts` patches
`connector.upserted` and `connector.deleted` workspace events, and reconnects refetch it. The
server publishes an entry only when what clients see of it changed. The Connectors sidebar panel
shows each connector's status and queue, and its dialog adds or edits one, offering the account's
dev tunnels. Team panes resolve a connector author through the same lookup as agents.

## Boundaries and invariants

- Agent Teams never accepts inbound connections for connectors; the connector is the server.
- The database is authoritative for definitions, cursors, the outbox, and conversation threads.
  Live status is the only in-memory state.
- Content is free-form. The envelope carries only routing, idempotency, and provenance.
- Connectors don't replay work. A connector reports an interrupted turn with a `notice`.
