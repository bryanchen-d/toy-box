# Teams

A Team is a standing group of agents that works toward a purpose on the user's behalf. The user
says what they want. The Team's lead frames the work, keeps a public task list, and brings in
specialist members only when their work becomes actionable. The team coordinates in one shared
transcript, much like a team chat: agents mention one another to hand off work, react to
acknowledge it, post statuses while they work, and share artifacts and a runnable preview as the
result takes shape. The team lives on the server, so work continues after the browser closes, and
the sidebar draws the user back only when it matters: an unread update, a question the lead
flagged, or a task list it completed.

A Team is not a filtered Session or several Sessions side by side. Its defining split is private
thinking versus public collaboration. The lead and every member are durable Team-owned Workers
with private Sessions where they reason and use tools, and none of that private work enters the
Team. The Team transcript is the complete public coordination surface, so everything the team
shares, and everything the user sees, was deliberately published. The user is the team's
stakeholder rather than part of it: an unmentioned user message reaches the lead, and the lead stays
accountable for the purpose and for the quality of every member's outcome.

## How a Team unfolds

1. **Create.** The Team and its lead commit together, and the lead starts immediately. With a
   purpose, it frames the work and posts a kickoff. Without one, it asks the user what to work on.
2. **Staff.** As work becomes actionable, the lead creates members with focused roles. Each one
   onboards by reading the Team and establishing its role and avatar.
3. **Coordinate.** One audience policy routes every message, and mentions wake exactly the agents
   they name. A woken agent runs one private turn: it reads the Team, acts publicly, and
   finishes, optionally leaving a waiting status.
4. **Involve the user.** The lead sends a question flagged as a request, or posts a result and
   completes the task list. The sidebar holds each until the user replies or reads it.
5. **Keep going.** Follow-ups and routines privately wake the lead on a schedule, so ongoing work
   advances without anyone posting.
6. **Pause.** The user can pause or resume the Team from either team menu. Pausing durably
   stops the lead and all members, including Sessions still starting, and suppresses message,
   follow-up, and routine wakes. Messages still save, and history, members, tasks, and schedules
   remain intact. Resuming immediately wakes the lead to read the Team and continue.
   The composer still completes existing mentions while paused, but never offers to create an agent.

## Domain model

```text
Team           name, purpose, directory, lead model, tasks, preview, user read position
├─ Roster      the Team's agents
│  ├─ Lead     intrinsic and fixed; its Worker and Session ID is the Team ID
│  └─ Members  created on demand; editable and removable
├─ Transcript  sequenced user, agent, and system messages, plus agent reactions; replies form threads
├─ Artifacts   shared workspace files
└─ Routines    scheduled prompts that privately wake the lead
```

- `Team` owns its name, optional purpose and working directory, lead model, public
  tasks, paused state, optional URL-or-screen preview, human read position, latest message sequence, and updated time.
  Its `requestSequence` and `completedSequence` refer to transcript milestones. Completion is unread
  when it follows `seenThrough`; a request remains pending until a user reply clears its sequence.
- `TeamTask` has a short, stable, team-unique ID such as `t12`, title, status, optional owner
  and subtasks. Its optional `artifactId` is a shared artifact's `id`; file metadata
  stays with the artifact. Its optional `diff: DiffStats` uses `shared/diffStats.ts`, like Session
  diffs, and measures directly attributed work. `teamTasksDiff` derives totals from direct
  and descendant diffs, never storing aggregates. Unreported work differs from a measured zero;
  totals summarize reported work, not necessarily the net repository diff.
- `TeamAgent` is the shared public identity of anyone on the team, the lead or a member: ID,
  name, role, avatar, and status. A Team's agents, lead first, form its roster, which the overview
  presents as Team members.
- `TeamLead` is the fixed public identity of the intrinsic lead. Its Worker and Session ID is the
  Team ID. Its model belongs to the Team.
  Its read position and status live in the lead Worker metadata. The lead is not a member and never
  produces membership messages.
- `TeamMember` is the current public projection of one Team-owned Worker. The Worker ID is also
  its private Session ID and public Agent ID. The projection contains its name, optional role,
  model, avatar, and collaboration status. Its read position stays private in Worker metadata.
- `TeamMessage` has a durable ID and transactionally allocated sequence. User, Agent, and
  connector messages contain Markdown and optional attachments: images and videos to look at, and
  Markdown, text, and PDF documents to read or pass on. Typed system
  messages record name, purpose, directory, preview, membership, artifact, and undelivered
  connector-message changes. Agent senders retain only their stable Worker ID, so deleting
  a member preserves prior content while the UI presents a deleted identity. A connector sender
  retains its connector ID, and its message may carry `origin`: where the content came from and
  whether its requester is the owner. See [Connectors](../connectors/AGENTS.md).
  `tasks_completed` records the task list becoming complete. The lead flags an ordinary message with
  `request: true`; `requestSequence` points to that question until a user replies.
  A user, Agent, or connector message may reply in a thread: its `threadSequence` is the sequence of the
  earlier top-level conversation message that starts the thread. Threads are one level deep, so
  replying to a reply joins the same thread, and system messages neither start nor join one. A
  reply is an ordinary message in the same sequence, so reading, paging, reactions, requests,
  status targets, and replay need nothing thread-specific.
- `TeamReaction` is one Agent's durable acknowledgement or sentiment on a user or Agent message.
  It does not wake anyone or advance message sequence.
- `TeamArtifact` indexes a shared `WorkspaceFile` by its `id` (the file's identity), with its
  title and when it was first shared; sharing it again changes only the title. Every artifact
  carries its `id`, so tasks, apps, and native clients never derive it. Files owns the address and
  editor. Teams owns only the shared index and the `artifact_shared` transcript event, whose own
  timestamp records the share. `TeamState.artifacts` is the user's arrangement: pins come
  first in their own order, followed by new shares. The user can move any artifact or archive it, which clears its pin and files it away from the
  composer tray without unsharing it. Agents still read every shared artifact.
- `Team.canvasArtifactId` optionally selects one shared session-owned `.toy` artifact.
  The lead sets or clears it through `update_team`; validation rejects unshared files,
  machine files, and non-app artifacts. `canvas_changed` is a durable system message,
  reduced and replayed like preview changes. The artifact remains the source of truth:
  Teams stores no app code, app state, or alternate execution model.
- `TeamRoutine` is scheduled, recurring work that serves the purpose: a short title, a prompt, and
  a local-time cron schedule with one fixed minute, so it runs at most hourly. Adding, changing, and
  deleting one each append a typed system message that shows its title. Only the lead adds or changes
  routines. The user can run one immediately or delete it.
- `TeamState` is the canonical reduced detail: Team metadata, lead, members, messages,
  pending request, artifacts, routines, presence, and revision. A snapshot is a state value at one
  instant, not a separate type. Earlier messages page by sequence; revision is the durable replay cursor.

There is no separate Agent or membership database. Workers persists ownership, name, and opaque
metadata. Teams validates that metadata as role, model, avatar, `seenThrough`, and status, then
projects it into the fixed lead or an editable `TeamMember`. `model/worker.ts` owns these pure
projections for persistence and runtime configuration; private read positions stay out of public members.

## Algebra

### Team and roster

- Create a Team and its lead together, then immediately start the lead. With a purpose, the lead
  frames the current work and begins. Without one, the lead asks the user what they want to work on.
- Edit a Team's name, purpose, and lead model; list, read, and delete Teams. The sidebar and
  overview offer the same team menu and open the same create/edit form. Only the lead can change
  the Team's working directory through its `update_team` tool; the form shows it read-only.
  Existing private Sessions keep their provider and history. Model and directory changes take effect
  at each agent's next execution, not during active work.
- Let only the lead among Team agents rename the Team, revise its purpose, or change its
  working directory. Name, purpose, and directory changes create a durable system message;
  preview changes also create a system message, like sharing an artifact. Ordinary task updates
  stay out of the transcript and do not create unread state or list movement.
- Let the lead add, update, remove, and move tasks by ID with `edit_team_tasks`, committing an ordered
  batch against the latest tree. Updates preserve omitted fields and children; null clears optional
  fields. Removal deletes a subtree; moving appends it intact at the root or under a parent outside
  that subtree. Reserve `update_team`'s whole-tree replacement for initial
  planning or restructuring, preserving retained IDs and outcomes.
- Create, edit, start, finish, and remove Team members through their owned Workers.
- Let ordinary Sessions create and staff Teams, then read, post, share, and wait for the lead or
  members on the user's behalf. Let the lead create peers within its own Team.

Selecting an unknown mention creates a member in that Team and immediately starts its private
Worker Session for onboarding. The member reads context and establishes missing profile details, then
works on any assignment already received or finishes quietly. Idle membership is not a waiting status.
Mentioning a current member delivers instructions through the ordinary Session mailbox. Removing the member deletes that Session and Worker.
Members never exist outside their Team and cannot be invited from a global pool. The intrinsic
lead exists for the Team's lifetime and is addressed as `@lead`.

### Messages

- Append user, Agent, and typed system messages with one transactionally allocated sequence.
- Reply in a thread by naming any message in it. The append transaction resolves the thread's
  top-level message, rejecting system messages and messages outside the Team. Read one thread
  whole, without changing read state.
- Route every message through one pure `resolveTeamAudience` policy. An unmentioned user, member,
  or connector message wakes the lead. An unmentioned lead message wakes nobody. Explicit name-derived mentions
  wake exactly those agents, while `@everyone` wakes the lead and all members except the sender.
  An agent's handle addresses it anywhere in a message; any other handle, such as a connector's,
  addresses only among the mentions a message opens with and is otherwise plain text.
  The composer resolves the same policy for its draft, so it shows exactly who a message will wake.
  A thread never routes: its participants wake only as any message would wake them, so agents
  replying to each other can't loop without mentioning each other.
- Send a user or Agent message to each connector it opens by addressing, in the conversation its
  thread holds, and post a connector's events back into that thread. The composer shows addressed
  connectors as recipients beside the agents a message wakes.
- Set or clear one reaction per Agent without advancing transcript state.
- Register durable artifacts once and surface later file edits automatically. Attach screenshots,
  other images, recordings, and Markdown, text, or PDF documents to messages; generated images are
  attached by their saved paths. The transcript shows media in its viewer and opens a document on
  its own.
- Let the user arrange artifacts with `arrangeTeamArtifacts`: move a set before another
  artifact (or last), together in the given order, pin or unpin it, and archive or restore it. Moving one artifact,
  moving a selection to the top, and sorting the whole list are all this one verb. One pure
  `applyTeamArtifactArrangement` serves the server transaction and the browser's optimistic
  update. Arranging is quiet, like task revisions: one revisioned `artifacts` event replaces the
  list without a transcript entry or catalog activity.

### Status and reading

- Set or clear one member status without moving the Team list or waking peers.
- Advance human and Agent read positions monotonically.

### Attention and completion

- Let only the lead flag a user request or complete the task list. A flagged request commits with
  its message, and the completing task update appends `tasks_completed`. Both travel through the
  normal detail stream without ending the lead's turn.
  Reading a completion message acknowledges its sidebar indication. Reading a request does not:
  any later committed user message acknowledges it and also reaches the lead, preserving any
  explicitly mentioned recipients.
  Acknowledgement does not imply that the user's response resolves the request.

### Scheduled wakes

- Wake a lead privately when its follow-up or one of its routines comes due, or when the user runs a
  routine, through ordinary Session delivery. A run adds nothing to the transcript, and the lead
  posts only if something needs the team. Running a routine leaves its schedule unchanged.
- Paused Teams are excluded from due claims without consuming their follow-ups or advancing
  routine schedules. On resume, missed routine occurrences collapse into one as usual. Manual runs
  and new member admission reject while paused; user messages save without waking anyone.
  Only user edits can change `paused`; `team_paused` messages synchronize and replay this fact.
  Team edits serialize stop/resume effects, and agent configuration rejects execution while
  paused, including direct private-Session starts. This does not disable unrelated workspace
  Automations or terminate detached programs an agent previously launched.

## Agent execution

`server/agent.ts` composes current Team identity, purpose, working directory, collaboration
instructions, explicit model, and tools whenever a private Session starts an execution. Application
configuration composition resolves workspace model defaults while preserving an existing provider.
Sessions owns directory fallback and applying configuration between executions. The lead can
inspect the same model catalog as the client before creating peers. Member profile and Team
directory changes apply between executions without mutating provider history. The lead receives its
fixed identity and responsibilities from the Team rather than editable Worker metadata. Among
Team agents, it alone creates members and updates the directory, public purpose, tasks, and
preview.

A lead and member always receive `read_team`, `send_team_message`, `set_agent_status`,
and `finish_agent_turn` without tool discovery. These declarations set Sessions' `alwaysAvailable`
policy; optional team tools retain native discovery. Tool names and availability participate in
the configuration key, so a changed policy reconnects an idle agent on its next wake without
recreating its Session, membership, or read position.

All Team agents also receive `list_teams` and `inspect_team`. Inspection accepts a
`team:ID` URI, optionally followed by `/members`, `/agents/AGENT_ID`, or `/messages/SEQUENCE`.
IDs are URL-escaped, stable identities, never names or mention handles. A message reference reads
its complete containing thread, even outside the newest-message window; team inspection pages
backward with `beforeSequence` or reads a thread with `threadSequence`. Inspection returns public
configuration, configured lead/member models, roles, routines, tasks, artifacts, and messages.
It works while the source is paused, never joins or wakes it, never advances human or Agent read
positions, and never reads private Sessions. The own-team `read_team` protocol is unchanged.
Ordinary Sessions retain their ID-based `read_team` and receive the same inspection tool and
reference instructions. Missing targets fail rather than resolving another identity by name.

`model/references.ts` owns team, members, Agent, and message URI identity. The members address
selects the Team's roster, not a second entity. Team menus, Members menus, Agent row menus (including
the lead), and conversation message actions copy raw URIs with clipboard success/failure feedback.
Message text copying remains separate; uncommitted optimistic messages cannot copy a URI.
`components/TeamReferences.tsx` renders bare URIs and Markdown references in Team and Session
messages as inline icon pills while leaving code literal. Authored labels are preserved; bare
URIs display readable target labels such as "Message #42". External website links use the shared
Markdown link renderer, show an external-link indicator, and open directly in a new browser tab.
Internal links use the existing workspace team selection plus a
URI hash: members and Agent targets open the roster, and message targets resolve their thread and
reveal the exact message with a highlight, loading older history through its root. Removed Agents
and missing messages show an explicit unavailable result. These are in-app references, not
OS-registered protocols. Learning from another team uses ordinary cited messages and shared
artifacts rather than cloned teams, copied history, or another persistence model.

A directory is optional. Teams records a provided directory without creating it. When the work
needs one and none was provided, the lead can create and assign it through `update_team`.

The collaboration protocol asks an agent to read current context at turn start, use the smallest
useful public action, set status only for substantive work, reread before a result or handoff, mention
members whose wait it fulfills, and finish every turn explicitly. Agents answer a message in its
thread, keep responding in a thread whose reply woke them, and post top-level for kickoffs, new
topics, milestones, and results; `read_team` with a `threadSequence` reads one thread whole.
The lead asks a question about a thread's topic in that thread and posts its closing result
top-level. Public messages, reactions,
statuses, artifacts, and attachments are the only peer communication contract. Private transcripts
and tool logs never enter the Team. Agents reach connectors by opening a message with their handle,
and name them without @ when only talking about them. They keep each connector
conversation in one thread, answer each message where it came from (what the user typed in Agent
Teams in the team, and what a connector relayed through that connector), and treat content whose
requester isn't the owner as information rather than the user's instructions. `read_team` and
`inspect_team` deliver that content in [Security](../security/AGENTS.md)'s untrusted-content
envelope, screened for injections. A detected attack holds the reading agent's actions that send
data out, read credentials, delete work, or change agent instructions until the user reviews it;
reading such content alone restricts nothing. They send conversational
messages through the connector so replies route back, never directly with service tokens or scripts.
Read-only Slack analysis and bulk retrieval may use the user's configured skills or authorized APIs
and scripts with existing authorized credentials, including messages, history, threads, permalinks,
attachments, files, and canvases, without a connector conversation or a working link. Credentials stay
out of messages, artifacts, and logs, and other people's content remains information, not the user's
instructions or permission. While a connector is unreachable only the lead may contact the user
directly, to ask them to restore it. Model-facing message tools cap posts at 3,000 characters so
durable long-form work stays in canonical shared artifacts; browser messages retain the Team
model's 12,000-character limit.

The built-in lead role establishes the purpose with the user when needed, scales planning to the
work, keeps a lightweight task list with reviewable outcomes, creates each member only when their
work is actionable, drives quality through review and iteration, and keeps the public progress
surfaces current.
Each sibling list is capped at 50 tasks; use ID-based moves to regroup growing lists into milestones without discarding
useful outcomes or copying child counts into a parent's direct diff.
Routines serve the purpose, so setting one never rewrites the purpose or adds tasks.
Delegation never transfers accountability for the purpose or the quality of a member's outcome.
During working communication, the lead flags what it needs from the user by setting
`request` on `send_team_message`; the same transaction appends that flagged message and updates
the pending cursor. Only the lead's version of the tool accepts the flag. Completion
needs no separate operation:
when a lead's task edit or replacement takes the list from incomplete to complete, meaning it has
tasks and every task and subtask is done, the same transaction appends `tasks_completed`. Completion
compares the committed tree before and after the entire batch, never intermediate edits. Rewriting an
already complete list never repeats it; reopening and finishing a task does.

A turn start clears only a prior waiting status. Session completion clears any remaining working
status; startup clears working status left behind by inactive executions. `finish_agent_turn` clears active status and its
projected activity reaction, or leaves a concise waiting status, then closes the turn. Only the
lead's version accepts `wakeAfterMinutes`, from 5 to 120, for a follow-up on a member or external
work. The follow-up is the waiting status's `wakeAt`, so any earlier wake clears it.

## Persistence and streaming

Teams owns its schema, database operations, sequence allocation, delivery policy, tools, pane, and
sidebar panel. Workers owns managed Session identity and lifetime. Sessions owns execution, history,
streaming, completion, and worktrees. Workspace owns pane placement and cross-feature synchronization.

Teams spawns the lead and members through Workers with durable retention. Its admission callback
commits the Team and lead together, or a member and its membership message together, before
execution begins, and returns the committed Team or member through the Worker receipt. Removing a
member transactionally changes the Worker record and appends its typed system message.
Removing a member also clears that member from task ownership. Profile and status changes update
Worker metadata and advance the Team revision. Deleting a Team removes its rows and Worker
ownership together, publishes one deletion, then tears down every captured agent Session. Those
teardowns cannot produce member departures for the deleted Team. Name, purpose, and directory
changes update Team metadata and append a separate typed system message for each changed property
in one transaction, advancing sequence and revision for each; a user purpose change also wakes the lead
to read the new direction. Preview changes append `preview_changed`; tasks and lead-model changes
have their own revisioned events without a transcript entry, as does an artifact arrangement, which
rewrites each artifact's `position`, `pinned`, and `archived` columns. Pins sort ahead of positions; a new share takes the position before
every other. Human read-position advances also
have a revisioned event carrying only the committed cursor.
Private Agent read-position changes update only Worker metadata. Message, reaction, and artifact tables continue
to reference the stable Agent ID without a foreign key so authored history survives member removal.
Routines keep a server-private `next_at`. A 30-second interval from `server/startup.ts` claims due
follow-ups and routines in one transaction before delivery: a follow-up clears its waiting status,
and a routine moves past now, so runs missed while stopped collapse into one.

The database is authoritative. Lead metadata updates and attention operations authorize against the
Team's intrinsic lead ID within their transaction. Task edits and replacements also validate
owners and shared artifact references in that transaction. Tasks stay in the Team's JSON column;
granular commands publish the same full-tree `tasks` event as replacement. Outcome-only updates
stay quiet and unchanged edits allocate no revision. The list query returns metadata and members
for the sidebar. The fixed lead identity is derived from the Team ID.
Commits persist the reducer's request and completion cursors alongside their messages; reads select
those cursors directly. The snapshot retains request content by that sequence, while transcript
presentation separately distinguishes each historical request's acknowledgement.
A visible pane observes a `TeamState` through one streamed Query: the first connection supplies
the snapshot, and later connections resume the cached revision. The server commits canonical rows
and publishes transitions, reusing metadata and roster reducers without retaining a second aggregate.
The same catalog projection supplies list snapshots and existing `team.upserted` events for
messages, reads, and metadata edits. One publisher forwards committed detail events and their catalog
projections. Member upserts/deletions patch identity-only catalog members (ID, Team ID, name,
avatar) without refetching the list. The sidebar gets activity from workspace sessions; descriptive
status belongs to the detail stream. Attention needs no additional workspace event or detail state.
`useTeams()` composes the catalog and workspace activity into entries with a Team, its agents
and their `isRunning` flags, and a derived `status` (waiting for a reply, unread completion, or unread
messages). The sidebar and Apps SDK share this hook and the same caches. Badge text and suppression
of unread/completion badges for open panes stay in the sidebar.
The route loads the catalog before subscribing to workspace events. Live events patch that cache;
an event overlapping a refetch triggers TanStack's native replacement refetch. Reconnects refresh
the complete catalog. Create/edit responses invalidate it rather than replay potentially older
rows over live updates. Message and read cursors are not catalog versions.

Message sequence is transcript order and the basis of paging and read positions. Revision is detail
state order and advances for every durable public change, including tasks, model, shared reads,
reactions, profiles, and statuses. A bounded replay ring repairs changes missed by a reconnecting
client, including reactions on older loaded messages. Presence is transient and refreshed on arrival.

Agent reads move forward from private `seenThrough` and advance it. Passive Session reads page
backward without changing read state. Agent-facing projections use `agentId` for both the lead and
members, matching message senders, reactions, and waiting. These projections expose exact mentions,
roles, and effective statuses, never separate private Session IDs or another member's read position.
Artifact shares and reads expose
`artifactId` alongside the path and title, so the lead can attach the same file identity to a task.
Task-edit receipts return only the targeted IDs.
Presence governs working/waiting/idle for clients and tool projections; stored status supplies text
and message targets only while its state matches that presence.

### Shared client protocol

`GET /api/v1/teams` exposes the existing catalog as `{ version: 1, teams, members }` for
client team selection, using the same list operation as browser RPC.

`GET /api/v1/teams/:teamId` streams SSE for browser and native clients through `streamTeam`.
Its snapshot event carries a `TeamState`; snapshots are part of the stream protocol.
The snapshot includes the latest 100 public messages, roster, artifacts, routines, live presence,
and the pending request even outside that message window. Its durable facts come from one
transaction. Reads never acknowledge the Team or expose private Agent context. Artifacts carry
the `id` that tasks reference as `artifactId` and a Files serving URL, so clients match task
outcomes without knowing the file identity encoding. Each attachment is either `{ name, url }` for
a file or `{ mimeType, base64 }` for an inline upload. Stored paths remain available only in the
agent tool projection.

The stream establishes state and follows changes:

- No cursor: send `{ type: "snapshot", state }` with one complete `TeamState`.
- `after` or `Last-Event-ID` (including zero): replay contiguous durable events, then send current
  `{ type: "resumed", presence }`, including explicit idle agents. An unavailable
  replay becomes a replacement snapshot; clients discard older loaded history and can page it again.
- Live durable events forward directly. The observer keeps only the roster needed to project
  runtime presence; it does not reread metadata or history on each event. Presence updates send
  only changed agents. Subscribe before reading so changes during bootstrap follow its coherent view.
- Deletion sends `{ type: "deleted", teamId }` and closes, including when the Team is already
  absent on connection. Workspace deletion also removes closed panes.

`reduceTeamState` applies the complete public protocol: messages derive metadata and attention,
quiet events replace tasks/model/read state and the artifact arrangement, and presence updates
merge or replace the presence map.
The separately retained pending request follows replies and reactions even outside the message window.
Optimistic posts enter the reducer with their client-generated message ID without advancing server
cursors or clearing attention; the committed echo replaces that message and applies its authoritative
position and metadata. Older pages merge already-materialized messages without replaying their events.
`useTeam()` exposes the live state, unread boundary, history paging, and `postMessage` bound to
that Team. Posting supplies the message ID and invokes the shared mutation; the composer owns
only its draft and submission UI. The app SDK exports this same hook. Observation defaults to
`"active"`; visualizations use `mode: "passive"` to leave unread state untouched.
The server reuses the metadata and roster reducers at their owning boundaries; SQLite remains its
source of truth without a second live Team aggregate. Resource URLs are resolved on the server.

TanStack Query owns the browser's cached view, stream request, cancellation, and retries through
`streamedQuery` with append semantics. `stream.ts` adapts the same SSE endpoint Minecraft uses into
an async generator; each attempt reads the latest cached revision, and unexpected EOF retries.
There is no separate browser snapshot RPC or alternate native-client protocol.

The browser's `TeamQueryData` adds an arrival record to the state: a connection identity and the
unread boundary after its initial snapshot or post-replay `resumed` event. Replayed shared reads
therefore arrive before the browser captures that boundary. Paging, optimism, and later sparse
presence updates cannot masquerade as arrival. A terminal deleted event leaves a null detail value
and removes the catalog entry; Workspace deletion also retires the detail query. Both catalog paths
replace an overlapping stale list read. This browser metadata does not change the public protocol.

`GET /api/v1/teams/:teamId/messages?before=<sequence>` returns up to 100 older messages with
`{ version: 1, revision, messages }` from one transaction. The browser uses this same public endpoint.
It retries pages older than its cached revision, merges without advancing the stream cursor, and
continues through the target sequence when revealing a pending request.

`POST /api/v1/teams/:teamId/messages` accepts `{ id, content, attachments?, threadSequence? }`, uses the normal
user-message schema and delivery policy, and returns HTTP 201 with `{ version: 1, message }`.
Duplicate IDs return 409 without repeating delivery. `POST …/read` accepts `{ sequence }`, uses
the same monotonic read operation as the browser, and returns `{ version: 1, seenThrough }`.
Reading acknowledges completion but never answers a request. HTTP and RPC are thin entry points
to these capabilities under Agent Teams' existing trusted-owner server assumption.

## Presentation

The Team members aside hides AI credits by default and does not fetch usage until the user
enables "Show AI credits" in the title's actions menu. This toggle is local to the mounted
view. When enabled, it shows each current agent's private-session AI credits and their derived
team total, including the lead and provider-native subagents. A separate on-demand
`teamQueries.usage` read exposes only usage metadata, not private transcripts. It polls
every five seconds only while credits are enabled and the aside is visible (and pauses in hidden
browser tabs). Turning credits off hides the total, usage details, errors, and per-agent column
and stops this view's usage polling.
Missing reports show "Not reported"; incomplete team or session coverage shows a partial
subtotal. Load and refresh failures are explicit and retryable. The total covers the current
roster, not removed members or a cross-provider currency conversion. No billing data is
stored by Teams.

The same title menu's "Show model" toggle shows or hides the Model column for every agent,
including the lead. It is local to the mounted view, defaults on, and is independent of AI credits.

`TeamPane` takes a Team ID and owns one cached `TeamState` for its transcript, overview,
and composer. It does not read the workspace catalog or derive agent presence from Session state.
The sidebar uses the catalog and workspace activity independently; private Session previews and
Files remain explicit integrations with their own capabilities. `TeamPaneContext` shares one
roster, presence, the composer actions, and opening artifacts and the artifacts panel inside the
pane. The roster exists from the first
render, starting from the intrinsic lead, so the composer, transcript, and overview never derive
their own.
The composer shell and its intrinsic "To Lead" audience render during SSR. Hydration starts
observation; the first snapshot populates the tray and roster and enables input.
It uses the same shared composer shell and native `ComposerInput` as Sessions. Agent mentions remain plain `@handle`
text, so audience resolution and delivery are unchanged. The draft is the Workspace saved draft
`team:<id>`, so it survives reloads and follows the user across clients; reply and mention
actions edit it through the draft's verbs. A thread's composer is the same composer with its own
draft, `team:<id>:<sequence>`, and without the tray or request button. The composer owns the member-creation mutation and
binds it into one pure source. `agentCompletionSource.ts` owns the whole mention policy:
everyone, the lead, matching members by name, and an offer to create an unknown handle, whose
acceptance creates the member and resolves to its mention. The completion hook owns that
acceptance's in-flight guard and error, which the shared menu shows. Its trigger is the model's
`AGENT_MENTION_TRIGGER`, built from the same mention grammar that parses and delivers mentions,
so the menu completes exactly what delivery wakes. Each item's description is the agent's role or
what the option does. `AgentCompletionMenu` supplies avatars and edits a member by opening its
editor through the shared `CompletionMenu`, which shares menu chrome, item text, editing, group
headings, active-item scrolling, and focus-preserving click/tap acceptance with Sessions; touch
scrolling never commits a mention. An agent editor opened from the menu outlives the menu it was opened from.
The input grows through three rows and retains the existing toolbar typing effect.

The workspace deduplicates Team panes by Team ID. Panes and apps share one Query
stream. `subscribed` detaches hidden views, and Query cancels when the last observer leaves;
cached content and mounted drafts remain. On return, replay catches up that cache and establishes
the unread boundary before read acknowledgement or initial unread scrolling. A reader joining an
existing observer captures the current shared read cursor. Arrivals during reading do not move that boundary. A deleted event
ends observation and reaches the pane's existing unavailable boundary.

The Canvas control opens the selected artifact beside chat in a wide team pane,
or switches to it in a narrow pane. Visibility belongs to each mounted team view,
not shared team metadata. `TeamCanvas` uses Files' read/watch lifecycle and
the existing `ArtifactAppPane`, with a team-specific publisher identity so its
linked panes do not collide with a separate editor of the same app. Closing cleans
up that observation without stopping team agents. App failures stay within the
canvas. Agents follow the bundled app-authoring guidance for public user requests,
delivery versus completion, freshness, and trusted-code limits.

`TeamThread` shows one thread the same way: beside chat in a wide pane or in its place in a
narrow one, as the view's single aside alongside the canvas. It renders `threadRows` with the
transcript's own row component and a thread composer, opens on a pending question it holds or else
its latest reply, and follows new replies at the end. Loaded history always reaches the newest
message, so a loaded top-level message has every reply loaded; opening an older thread pages history
through its top-level message, as revealing a pending request does. Every user and agent message
offers "Reply in thread", which opens its thread with the draft addressed to its agent, as the
former Reply action did. A message still being sent offers none until it commits. "Input needed"
opens a question asked in a thread.

Teams and threads use the shared `MessageSearch` popup and focused-pane `Ctrl+F`/`Cmd+F`.
Team search includes all public user and agent messages and their replies, independently of
the current transcript view; thread search includes only its root and replies. The database scans
conversation text newest first in bounded pages, returning at most 20 literal, case-insensitive
matches with bounded snippets, without hydrating attachments, reading private Sessions, waking
agents, or advancing read positions. Queries run only while search is open and visible.
Choosing a Team result reuses the message-reference path: open its containing thread, load
history through the root, and reveal and highlight the selected message. Within a thread,
selection scrolls and highlights in place without remounting its composer or restoring end following.

`TeamArtifacts` is the artifacts panel, where the user manages what the composer tray shows. It
opens from the panel bar, the tray's full list, and the overview, and lists the Shared or Archived shelf with
search. Each artifact opens on click, drags by a gutter grip on the Shared shelf while unfiltered,
and has a menu to move it to the top, up, or down, or to archive or restore it. Moves stay relative
to the artifact's pinned or unpinned group while searching. A selection of visible artifacts archives, restores, or moves
to the top together, and Sort arranges only unpinned Shared artifacts once by newest, oldest, or name. A drag
reorders locally until its optimistic arrangement replaces the list.

The pane's right edge is `TeamPanelBar`, with a top show/hide button followed by one toggle per
panel: overview, canvas (available once the lead sets one), members, tasks, artifacts, routines,
and security, which is marked while one of the Team's agents has an open finding.
The top button replaces header close buttons; its chevron points right to close and left to reopen
the last selected panel while the pane remains mounted, or overview if none was selected or its
canvas is no longer available. One aside shows beside chat at a time. Choosing a panel replaces
the current one, and choosing it again returns to chat. A thread, a
message search result, or a members or agent reference opens over the panel, and closing it returns
to the panel. A normal pane opens the panel the Workspace surface remembers in the layout cookie,
so it persists across reloads and Teams; a compact pane keeps its own and opens on chat.

In a wide pane, chat and the aside form one resizable panel group divided by the shared
`ResizableHandle`; a narrow pane hides chat and the divider, so the aside fills it. Each aside
kind is its own panel with its own share of the pane, 50% for the canvas, 65% for members, and
30–35% otherwise until resized within 25–75%. The divider commits the share a drag or keyboard
step leaves, and the Workspace surface remembers it per kind in the layout cookie.

`useTeam.postMessage` returns the persisted message, or rejects on delivery
failure. The composer returns that promise to its draft lifecycle for restoration
on failure and renders `postError`. Apps must not treat delivery as agent completion.
Receipts must match the submitted message ID and contain a committed sequence.
Query-local `optimisticMessageIds` distinguish uncommitted messages from server
echoes. A failed post removes only its still-optimistic message, preserving
committed echoes, concurrent changes, and mounted canvas feedback.

`TeamUserMessage` adds mentions, reactions, and timeline timestamps to the shared
[`UserMessage`](../../shared/messages/UserMessage.tsx), whose right-aligned light-blue bubble also
styles human replies inside the thread view. Thread activity in the main transcript aligns right
and uses the same blue surface when its latest reply is human; agent activity stays left-aligned
with a dashed border. Human bubbles and participant icons use a muted dark-blue surface in the dark
theme. Agent messages reuse the shared
[`CopyControl`](../../shared/messages/CopyControl.tsx). `TeamReactions` takes a message and
shows its recorded and projected reactions, or nothing. Every agent reference, whether an author,
reactor, task owner, or sharer, resolves through `teamAgentIdentity`, so a removed agent
presents one deleted identity everywhere.

- The transcript's rows come from `transcriptRows`, its pure presentation model: each user message
  stands alone, one agent's consecutive messages form a run, and matching system messages merge.
  Replies stay with their thread. A reply joins the row holding its thread's top-level message when
  that is the latest row; otherwise consecutive replies to one thread form a thread row where they
  arrive, so new replies stay in view of a reader at the end, under the same "New" rule, without
  any per-thread read state. A message that starts a thread summarizes its replies, who wrote them,
  when the latest arrived, and any question among them, all derived from loaded messages.
  Each message in a run carries its addressee, its body without the leading mentions that addressee
  names, its request state, whether it repeats the run's header, and whether it collapses. One
  optional divider precedes a row, labeling a new day, marking where unread messages begin with a
  blue rule and "New", or both at once rather than stacking two rules. `SystemMessageGroup` defines
  each kind's static icon and presentation function together in one local object; each function
  receives its kind's typed contents. Its shared row renders the resulting content and tooltip;
  grouping and the durable message model stay separate.
  A pane-local view, chosen beside the transcript's message search, shows
  all messages or only the user's own and the agent messages that never collapse. Rows form from
  the shown messages, so runs and dividers follow what the reader sees; changing the view lands
  the transcript afresh, and read state stays Team-wide.
  `useTranscriptViewport` owns the virtualizer and where the reader looks: landing on the first
  unread row or the end, following the reader's own post, revealing the pending request, and
  paging history. Paging continues while the first row, or an empty view, is in view, so a sparse
  view fetches pages it may show nothing of instead of asking the server to filter.
  TanStack Virtual's mutable instance stays inside that hook, which the compiler
  skips, and the transcript receives only values current for its render.
  The "New" position comes from the current read position on arrival and holds
  while it's read, so arrivals during reading are never marked. A flagged question is marked until a
  later user message acknowledges it. The activity row shows working agents; waiting
  shows in the members panel, since a request already marks what the user needs to answer.
- The composer docks Workspace's [`ComposerTray`](../workspace/components/outputs/ComposerTray.tsx)
  for shared artifacts in the user's arrangement, without archived ones, plus the tasks and
  preview. Each artifact in the tray's full list offers to archive it, and the list ends with
  Manage artifacts, which opens the artifacts panel. URL previews
  retain their sandboxed hover iframe and open in a new tab. Screen previews
  show a passive live canvas and open/focus a Screen pane without opening a
  private agent Session. Tray, overview and historical preview messages share
  Workspace's preview presentation. Opening never takes input control.
  While the Team reports a pending request, it asks for a reply.
  An "Input needed" button beside the composer's audience stays visible
  until the user replies. Hover previews `state.request`; clicking loads
  any older pages needed and scrolls to the question. Scrolling never changes the composer height.
- The overview panel shows the purpose, directory, and preview, then summarizes each other panel
  under a View all link that opens it: the roster's avatars and how many are working, task progress
  with up to three tasks in progress, the first three Shared artifacts, and the next routine to run.
  Its header holds the team menu.
- The tasks panel holds the full task checklist. The routines panel lists routines by title with
  their next run, each expanding to its prompt and offering Run routine and Delete routine. The
  members panel adds an agent through the composer's mention and removes members after
  confirmation, alongside its roster table.
- Both checklists share a task projection with stable identity and compact diff totals (exact counts
  on hover and for assistive technology). Naturally sized counts and owners float beside the first
  title line, without reserved columns. Pending rows omit diff counts; reported zeros use the same
  added/removed colors as other counts. Counts and avatars keep their normal colors on done rows.
  Artifact references stay on their directly attributed tasks and never roll up. Artifact icon actions
  share that detail slot and open ordinary file panes without toggling the parent; their hover
  and accessible labels identify the artifact, while full titles stay in the artifact list.
  Inline disclosures keep direct-child progress with the title in the same count badge as section
  headings; a parent's own artifact action remains visible while collapsed. The tasks panel and popup
  share a heading layout with a count badge and the whole-list diff at the right. The progress bar
  appears only in the desktop composer-tray pill.
- Sidebar priority is waiting, unread completion, ordinary unread, then live lead/member activity;
  open teams suppress completion like unread, but never suppress an unanswered request.

## Code map

- `model/` is the isomorphic domain. `index.ts` owns the types, input schemas, audience policy, and
  public exports. `tasks.ts` owns task identity, outcome schemas, derived diff totals, tree edits,
  ownership release, and completion. `agent.ts` owns agent names, roles, avatars, the lead profile, mention
  handles, and the deleted identity an ID resolves to once its agent is removed. `worker.ts` projects Worker metadata into the lead, members, and roster. `reducer.ts`
  reduces the complete public snapshot and owns the metadata and roster transitions shared with
  the server. `presence.ts` and `reactions.ts`
  derive how agents and reactions display.
- `server/` owns authority. `schema.ts` and `database.ts` own tables and transactions. `index.ts`
  composes the algebra for RPC, tools, and wakes. `functions.ts` is browser RPC ingress, and
  `stream.ts` composes public views and owns observation using `events.ts`'s detail replay ring.
  The versioned SSE route delegates to that owner through `api.ts`.
  `resources.ts` resolves client URLs before publication or snapshot delivery.
  `tools.ts` owns agent-facing projections and the Session, lead, and member tool sets; `agent.ts` composes each agent's
  execution, and `startup.ts` clears finished working statuses and starts the wake interval.
- `queries.ts`, `stream.ts`, `mutations.ts`, `queryCache.ts`, and `useTeam.ts` own client data:
  catalog and streamed detail queries, the SSE adapter, mutations, catalog event patches, and one
  open Team's visibility and read lifecycle.
- `components/pane/` holds the pane, composer, thread, artifacts panel, and shared pane context, with `transcript/` and
  `overview/` beneath it. `components/agents/` holds avatars, mention Markdown, the mention
  source and menu, the member editor, and working agents. `components/sidebar/` holds the Teams panel, the
  collapsed sidebar's Team tabs, and their shared attention priority. The top level holds the create/edit dialog and team menu.
- Outside this folder, [Workers](../workers/AGENTS.md) owns agent identity and lifetime.
  [`sessionConfiguration.ts`](../../server/sessionConfiguration.ts) grants ordinary Sessions the
  Team tools and resolves agent configuration, and
  [`managedSessions.ts`](../../server/managedSessions.ts) detaches a deleted agent's Session.
  [Workspace](../workspace/AGENTS.md) places the pane and sidebar panel and synchronizes
  `team.*` events.
