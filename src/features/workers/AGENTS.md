# Workers

Workers are owner-bound Session identities. They let a Session delegate work, a file run a background
edit, an app run private implementation work, Inbox supervise background results, or a Team retain its lead and members without
introducing another execution model.

## Model

A `Worker` has one Session ID, creation time, owner, and lifetime; only a team member's owning team
can change. Spawning constructs
and persists that identity and starts its first execution. Team members start onboarding when
they join; subsequent mentions use normal Session delivery. Optional `name` and opaque `metadata`
are owner-provided details. Owners validate their metadata's meaning; Workers validates bounded JSON
before publishing a new Worker or updating its metadata.

`WorkerSpawn` combines a Session launch with an owner, optional name and metadata, and a retention
policy. Trusted owners may supply a shared Session ID. Teams uses its own ID for its lead.

- A session-owned Worker inherits its parent's model and directory unless overridden and is retained
  by default. Spawning does not open a pane; children are discoverable under their parent in the
  sidebar, and `open_session` explicitly opens them. Agents call them sub sessions (below).
- A file-owned Worker belongs to one exact session file and is always ephemeral.
- An app-owned Worker belongs to one saved app and is ephemeral by default.
- A team-owned Worker is durable until member or Team deletion. Teams interprets its name
  and metadata as member identity, read position, and collaboration status. The Team derives its
  intrinsic lead's fixed identity and owns its model. A member, never a lead, may move to another
  team (`moveToTeam`), the one change of owner Workers allows; its Session stays the same.
- An Inbox-owned Worker supplies a retention callback that keeps reported results and failures.
  Workers deletes clean completions without a result. Its metadata carries the Inbox message and
  optional artifact path.

Trusted spawning takes one `retention` policy: `"ephemeral"`, `"durable"`, or a callback receiving the
latest persisted Worker and its `SessionCompletion`. An ephemeral Worker's Session is deleted after
its current execution. A durable Worker survives for follow-up until explicit or owner deletion.
A callback returns true to retain or false to delete and may perform asynchronous owner-specific
finalization. Workers awaits that decision and cleanup before completing the receipt or clearing
active work. Cancellation and missing ownership bypass the callback; a callback exception retains
ownership and rejects completion.

The persisted `ephemeral` flag is derived from that policy. Callback-based work is stored as durable;
callbacks are process-local, and owners recover interrupted work after a restart. Startup and
execution exceptions after admission become failed completion data with an error string. Failures
before admission and cancellation during startup clean up the reservation. Worktree isolation
remains a Session concern.

The Worker model deliberately knows no Agent role, Team status, file editor task, or app state.
Owners validate and interpret metadata at their own boundary. This is the same pattern used by
`useFile`: Files selects its Workers by owner, presents their names and metadata, and invokes generic
spawn or cancel operations.

## Sub sessions

A sub session is a session-owned Worker that does one task for the agent that created it, reports
back to it, and is closed by it when the task is done. The Workers table is the only record of
which agent owns which sub sessions. Standard, Hyper, automation, inbox, file, and app sessions and
team agents share one toolset, `create_sub_session`, `message_sub_session`, `list_sub_sessions`,
and `close_sub_session` (`server/tools.ts`), with guidance on when to use a provider's own
subagents instead. Each tool acts only on the invoking session's own sub sessions
(`server/subSessions.ts`), whatever IDs its arguments name.

- Creating one takes a brief (`model/subSessions.ts`): goal, context, deliverable, acceptance
  criteria, and optional boundaries and reporting. It renders as the first message, after a note
  that names the owner, says each turn's final answer goes back to it, and asks the sub session to
  ask rather than guess. Sub sessions are retained; only their owner or its deletion removes them.
- A session owns at most five at once. Creation is serialized per owner, so parallel calls can't
  exceed the limit.
- Naming a `node` runs it on that pool node as the node's provider
  ([Providers](../providers/AGENTS.md#node-providers)), in a fresh folder there, so it takes no
  directory or worktree. A model it names applies only if the node offers it. Its brief asks it to
  push its work to its own branch at each milestone and name the branch in every report, which is
  how anyone takes the task over if the session is lost. `list_sub_sessions` shows each sub
  session's node and, with an agent pool, every node and its state; the instructions tell owners to
  prefer a connected node for work that doesn't need this machine.
- The brief is kept in the sub session's Worker metadata, so an interrupted report can return it.
- A sub session never owns sub sessions: session-owned Workers receive only `wake_after` from the
  set, and creation refuses a caller that is one.
- Closing cancels its work and deletes it, which also closes any pane linked to it.
- Each execution a sub session finishes, whoever prompted it, wakes its owner at once with a
  `sub_session_report` system message holding its final answer or error (`server/startup.ts`
  subscribes to Sessions' completions). An answer of exactly `NO_UPDATE`, or none, wakes no one,
  and an aborted run reports nothing. The owner checks the report against its brief.
- A run that stopped before it could finish reports `interrupted`, with its brief: one that failed
  while its node was out of reach, and, at startup, one under way when the server stopped. Workers
  notes each sub session's runs in its metadata (`working`) from the workspace's running and idle
  transitions, so a restart can tell which were under way. The owner messages it to carry on, or
  closes it and continues the task from its brief and last pushed branch, here or on another node.
  Metadata edits to one sub session run in turn, since each rewrites it whole.
- A report also lists the external writes the sub session ran since its previous report, which
  Security records as each one runs (`takeExternalWrites`), and a `NO_UPDATE` turn that made any
  still reports them. The owner checks each write against the brief's scope and what it knows.
  Closing returns any writes no report has listed yet.
- A sub session waiting on something slow calls `wake_after(minutes, reason)`, its only tool of the
  set. The wake lives in its Worker metadata, so it survives a restart; Workers checks every 30
  seconds and at startup, clears a due wake before delivering it, and the owner's next message
  cancels it.
- Each report also sets a reminder in the same metadata. A sub session still open and idle a day
  later, with no wake of its own pending, reminds its owner once with a `sub_session_idle` system
  message that queues behind the owner's work. The owner's next message cancels it.
- The team members table lists each agent's sub sessions with their live state, derived on the
  client from session ownership; a standard session's nest under it in the sidebar.

## Algebra

Workers owns lifecycle and owner-scoped storage capabilities:

- **Spawn** validates or injects an owner, assigns identity and creation time, publishes active work,
  persists admission, and creates the backing Session. An optional trusted `admit` callback can
  compose Worker persistence with an owner's atomic domain changes before execution starts;
  its return value becomes the receipt's typed `value`.
- **Cancel** verifies ownership, clears active work, and stops startup or execution.
- **Delete** removes the backing Session and its durable ownership record.
- **Read/update** lists retained Workers by type or exact owner, resolves an owned Worker, and
  updates name/metadata by Worker ID without changing ownership, identity, creation time, or lifetime.
  Omitted details remain unchanged; an explicit undefined metadata value clears it. Updates throw
  for a missing Worker. Initialization separately fills only absent metadata, returning false for
  existing metadata or missing ownership. Commands acknowledge writes; reads own projections.

Untrusted file and app creation enters through `spawnWorkerFromRequest` in `server/admission.ts`.
The trusted `spawnWorker` admits ownership; `superviseWorker` in `server/supervisor.ts` composes
Session creation with inheritance, cancellation, exact completion, and retention. Trusted
supervisors use the public `spawnWorker` with a complete `SessionLaunch`, `owner`, optional `name`
and `metadata`, and a required `retention` policy. Workers assigns the Session ID and creation time;
callers supply intent rather than constructing a persisted Worker. Supervisors apply their admission
policy before spawning. They receive the admission receipt once ownership is persisted and Session acquisition has been
registered, without waiting for provider startup or the first turn to finish. Follow-ups then join
Sessions’ existing acquisition and mailbox. Preparation failures remain failed completion data.
An owner can return its committed domain value directly from `admit` and receive it as `receipt.value`,
without capturing mutable outer state or re-reading storage. Its `waitForCompletion`
covers configuration inheritance, provider startup, execution, retention, and lifetime cleanup.
Admission failures reject spawning; retention and cleanup exceptions reject completion. File, App,
and Session tool ingress await the same admission boundary and return the serializable Session ID.
Inbox and Teams use this path for creation. Team admission commits the lead with its Team,
or a member with its membership message, before execution begins. Later mentions use Session delivery;
Teams has no separate activation operation or startup queue.

Waiting remains a Session operation. Admission registers completion before publishing
`worker.started`, so fast ephemeral work cannot disappear before `waitForSessions` observes it.
Unsuccessful execution outcomes remain data, including startup exceptions. Active Workers are
available through the public read API so owners can distinguish current supervision from retained
ownership.

## Boundaries

- `model/` owns the Worker value, owner variants, and externally validated spawn and cancel inputs.
- `server/schema.ts` and `server/database.ts` persist creation time, owner, lifetime, name, and metadata needed to
  classify, recover, and delete a Worker.
- Application composition projects those records into Sessions' typed ownership index, including
  parent relationships, so generic consumers need no separate Worker-classification cache.
- `server/registry.ts` contains only currently admitted background work and publishes
  `worker.started` and `worker.finished`. Durable Team membership is not active work.
- `components/WorkersMenu.tsx` presents active background work. Files and Apps select the Workers they
  own. Teams presents its durable Workers as the lead and members.
- Sessions owns execution, history, streaming, completion, provider configuration, and worktrees.
- Owners own all interpretation of their metadata and any richer public projection.
- Worker persistence and metadata operations do not publish owner-specific events. Owners publish
  their accepted workflow changes; application composition handles owner notification during shared
  Session teardown. Unregistration reports whether it removed a row so concurrent teardown does not
  publish duplicate deletions. Raw `WorkerDatabase` operations remain composable into transactions.
- Metadata writes enforce the shared bounded-JSON contract before changing a row. SQLite enforces
  JSON validity; reads decode that JSON without reapplying write limits to historical records.
  Owners decide how to present metadata that no longer satisfies their own result schema.

The Worker table is the only durable ownership record. An owner may compose `WorkerDatabase` into its
own transaction and resolve its own Session configuration or lifecycle behavior at the application
composition boundary. There is no second generic membership table, host abstraction, or parallel
managed-session type.
