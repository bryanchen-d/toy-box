import {
  acknowledgesTeamRequest,
  teamAudienceLabel,
  isTeamSystemMessage,
  messageAuthorId,
  resolveTeamAudience,
  withoutLeadingMentions,
  type TeamAgent,
  type TeamConversationMessage,
  type TeamMessage,
  type TeamPendingRequest,
  type TeamSystemMessage,
  type TeamTask,
} from "@teams/model";

// Consecutive messages from one agent within this window share a header.
const RUN_WINDOW_MS = 10 * 60 * 1000;

/**
 * Which messages the transcript shows: all of them; only the user's own messages and the agent
 * messages for them, which leaves out coordination between agents and system changes; or only the
 * questions that still need the user's reply.
 */
export type TranscriptView = "all" | "yours" | "requests";

type TranscriptRowContent =
  | { type: "user"; message: TeamConversationMessage; thread?: TranscriptThread }
  | { type: "agent"; agentId: string; entries: AgentRunEntry[] }
  | { type: "system"; messages: TeamSystemMessage[]; thread?: TranscriptThread }
  | {
      type: "thread";
      /** The replies that arrived here, after other rows separated them from their thread. */
      thread: TranscriptThread;
      /** The thread's top-level message, or a task's opening note, once loaded. */
      root?: TeamMessage;
    };

/**
 * One transcript row: a user's message, one agent's run, merged system messages or a task's
 * opening note, or replies in a thread whose top-level message is further up.
 */
export type TranscriptRow = TranscriptRowContent & {
  /** The first message's ID, which the row keeps as later messages join it. */
  key: string;
  /** Precedes a row that begins a day, the messages unread on arrival, or both at once. */
  divider?: { day?: Date; unread: boolean };
};

/**
 * A thread's replies, identified by the sequence of its top-level message, and the state of the
 * latest question among them. Loaded history always reaches the newest message, so a loaded
 * top-level message has every reply loaded too. Replies include the server's notes in a task's
 * thread.
 */
export type TranscriptThread = {
  sequence: number;
  replies: TeamMessage[];
  request?: TeamRequestState;
};

/** One message in an agent's run, as its header and body present it. */
export type AgentRunEntry = {
  message: TeamConversationMessage;
  /** The content without the mentions it opens with, which the addressee names instead. */
  body: string;
  /** The run's first message names its author. */
  startsRun: boolean;
  /** Who the message wakes; absent when it's for the user. */
  addressee?: string;
  request?: TeamRequestState;
  /** After a run's first message, a header appears only to say something new, such as a
   *  connector relaying a different person. */
  showHeader: boolean;
  /** Coordination between agents recedes; messages for the user and requests stay whole. */
  collapsible: boolean;
  /** The replies to this message, when it starts a thread. */
  thread?: TranscriptThread;
};

/**
 * Whether a question still needs the user's reply comes from the team's stored pending questions,
 * which stay current under every rule they were asked under; a settled one says how it was settled.
 */
export type TeamRequestState = "pending" | "replied" | "answered";

type RowContext = {
  lead: TeamAgent;
  members: readonly TeamAgent[];
  coordinators?: Readonly<Record<string, string>>;
  /** Each task by the sequence its thread starts at, which routes the thread's messages. */
  tasksByThread: ReadonlyMap<number, TeamTask>;
  /** The sequences of the questions still waiting on the user. */
  pending: ReadonlySet<number>;
  /** Every loaded message, where a settled question's acknowledgement is found. */
  loaded: readonly TeamMessage[];
  /** Loaded threads by their top-level message's sequence; absent within one thread's rows. */
  threads?: ReadonlyMap<number, LoadedThread>;
};

type LoadedThread = { root?: TeamMessage; replies: TeamMessage[] };

/**
 * The transcript's rows. A user message stands alone, one agent's consecutive messages form a run,
 * and membership changes merge, as do one agent's artifact shares. Replies stay with their thread:
 * they join the row that holds the thread, or else form a thread row where they arrive, so new
 * replies remain in view. Rows never span a day or the start of unread messages, so dividers always
 * fall between rows. Rows form from the messages the view shows, so runs and dividers follow what
 * the reader sees.
 */
export function transcriptRows(
  messages: readonly TeamMessage[],
  {
    lead,
    members,
    coordinators,
    tasks = [],
    pendingRequests,
    unreadAfter,
    view = "all",
  }: {
    lead: TeamAgent;
    members: readonly TeamAgent[];
    /** The team's connector coordinators, which connector messages wake. */
    coordinators?: Readonly<Record<string, string>>;
    /** The team's tasks, whose threads route their messages to the assignee. */
    tasks?: readonly TeamTask[];
    /** The questions still waiting on the user, as the team stores them. */
    pendingRequests: readonly Pick<TeamPendingRequest, "sequence">[];
    /** Where unread messages began on arrival; null or undefined marks none. */
    unreadAfter?: number | null;
    view?: TranscriptView;
  },
): TranscriptRow[] {
  const context: RowContext = {
    lead,
    members,
    coordinators,
    tasksByThread: tasksByThread(tasks),
    pending: pendingSequences(pendingRequests),
    loaded: messages,
    threads: loadedThreads(messages),
  };
  return rowsOf(messages, context, { unreadAfter, view });
}

/**
 * One thread as a conversation of its own: its top-level message, then its replies grouped as the
 * transcript groups messages.
 */
export function threadRows(
  messages: readonly TeamMessage[],
  sequence: number,
  {
    lead,
    members,
    coordinators,
    tasks = [],
    pendingRequests,
  }: {
    lead: TeamAgent;
    members: readonly TeamAgent[];
    coordinators?: Readonly<Record<string, string>>;
    tasks?: readonly TeamTask[];
    pendingRequests: readonly Pick<TeamPendingRequest, "sequence">[];
  },
): TranscriptRow[] {
  const context: RowContext = {
    lead,
    members,
    coordinators,
    tasksByThread: tasksByThread(tasks),
    pending: pendingSequences(pendingRequests),
    loaded: messages,
  };
  const thread = messages.filter(
    (message) => message.sequence === sequence || message.threadSequence === sequence,
  );
  return rowsOf(thread, context, { view: "all" });
}

/** Who replied in a thread, each once, most recent first; the server's notes have no author. */
export function threadParticipants(
  replies: readonly TeamMessage[],
): TeamConversationMessage["sender"][] {
  const participants = new Map<string, TeamConversationMessage["sender"]>();
  for (const reply of [...replies].reverse()) {
    if (isTeamSystemMessage(reply)) continue;
    const key = messageAuthorId(reply.sender) ?? "user";
    if (!participants.has(key)) participants.set(key, reply.sender);
  }
  return [...participants.values()];
}

function rowsOf(
  messages: readonly TeamMessage[],
  context: RowContext,
  { unreadAfter, view }: { unreadAfter?: number | null; view: TranscriptView },
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let previous: TeamMessage | undefined;
  for (const message of messages) {
    if (!isInView(message, view, context)) continue;
    const divider = dividerBetween(previous, message, unreadAfter);
    const row = rows.at(-1);
    if (!row || divider || !extendRow(row, message, context)) {
      rows.push({ ...startRow(message, context), key: message.id, divider });
    }
    previous = message;
  }
  return rows;
}

/** The latest pending request whose message is loaded, which a reply answers, and its row. */
export function pendingRequestRow(
  rows: readonly TranscriptRow[],
  sequence: number | null,
): { sequence: number; index: number } | undefined {
  if (sequence === null) return undefined;
  const index = rows.findIndex(
    (row) =>
      row.type === "agent" && row.entries.some(({ message }) => message.sequence === sequence),
  );
  return index < 0 ? undefined : { sequence, index };
}

/**
 * Whether history before the loaded messages may hold messages the view shows. The requests view
 * needs older history only until every pending question is loaded.
 */
export function viewNeedsOlderHistory(
  messages: readonly TeamMessage[],
  view: TranscriptView,
  pendingRequests: readonly Pick<TeamPendingRequest, "sequence">[],
): boolean {
  if (view !== "requests") return true;
  const oldest = messages[0]?.sequence ?? Number.POSITIVE_INFINITY;
  return pendingRequests.some(({ sequence }) => sequence < oldest);
}

/** "Today", "Yesterday", or the full day, adding the year only when it isn't the current one. */
export function transcriptDayLabel(date: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** The first message, and each that begins a day or the unread messages, starts a new division. */
function dividerBetween(
  previous: TeamMessage | undefined,
  message: TeamMessage,
  unreadAfter: number | null | undefined,
): TranscriptRow["divider"] {
  const startsDay = !previous || !isSameDay(previous.timestamp, message.timestamp);
  const unread =
    previous !== undefined &&
    typeof unreadAfter === "number" &&
    previous.sequence <= unreadAfter &&
    message.sequence > unreadAfter;
  if (!startsDay && !unread) return undefined;
  return { day: startsDay ? new Date(message.timestamp) : undefined, unread };
}

function startRow(message: TeamMessage, context: RowContext): TranscriptRowContent {
  const thread = threadOf(message, context);
  if (thread) {
    return {
      type: "thread",
      thread: transcriptThread(thread.sequence, [message], context),
      ...(thread.root ? { root: thread.root } : {}),
    };
  }
  if (isTeamSystemMessage(message)) {
    // A task's opening note starts its thread, and summarizes its replies like any other.
    const replies = context.threads?.get(message.sequence)?.replies;
    return replies
      ? {
          type: "system",
          messages: [message],
          thread: transcriptThread(message.sequence, replies, context),
        }
      : { type: "system", messages: [message] };
  }
  const { sender } = message;
  const authorId = messageAuthorId(sender);
  if (authorId) {
    return { type: "agent", agentId: authorId, entries: [agentRunEntry(message, context)] };
  }
  const replies = context.threads?.get(message.sequence)?.replies;
  return replies
    ? { type: "user", message, thread: transcriptThread(message.sequence, replies, context) }
    : { type: "user", message };
}

/**
 * Adds the message to the row it continues: a reply to the row holding its thread, an agent's
 * message to its own run, or a system message to matching ones.
 */
function extendRow(row: TranscriptRow, message: TeamMessage, context: RowContext): boolean {
  const thread = threadOf(message, context);
  if (thread) {
    if (row.type === "thread" && row.thread.sequence === thread.sequence) {
      row.thread = transcriptThread(thread.sequence, [...row.thread.replies, message], context);
      return true;
    }
    // A reply below its top-level message is already in its summary.
    return (
      (row.type === "user" && row.message.sequence === thread.sequence) ||
      (row.type === "system" && row.messages[0]!.sequence === thread.sequence) ||
      (row.type === "agent" &&
        row.entries.some((entry) => entry.message.sequence === thread.sequence))
    );
  }
  if (row.type === "system" && isTeamSystemMessage(message)) {
    const group = systemMessageGroup(message);
    if (group === undefined || group !== systemMessageGroup(row.messages[0]!)) return false;
    // A task's opening note with replies keeps a row of its own, where it summarizes them.
    if (row.thread || context.threads?.has(message.sequence)) return false;
    row.messages.push(message);
    return true;
  }
  if (isTeamSystemMessage(message)) return false;
  if (row.type !== "agent") return false;
  if (messageAuthorId(message.sender) !== row.agentId) return false;
  const last = row.entries.at(-1)!;
  const gap = Date.parse(message.timestamp) - Date.parse(last.message.timestamp);
  if (gap > RUN_WINDOW_MS) return false;
  row.entries.push(agentRunEntry(message, context, last));
  return true;
}

/** The thread a reply belongs to, when the rows group replies into threads. */
function threadOf(
  { threadSequence: sequence }: TeamMessage,
  { threads }: RowContext,
): { sequence: number; root?: TeamMessage } | undefined {
  if (sequence === undefined || !threads) return undefined;
  return { sequence, root: threads.get(sequence)?.root };
}

function transcriptThread(
  sequence: number,
  replies: TeamMessage[],
  context: RowContext,
): TranscriptThread {
  const question = replies
    .filter((reply): reply is TeamConversationMessage => !isTeamSystemMessage(reply))
    .filter(({ request }) => request)
    .at(-1);
  const request = question && requestState(question, context);
  return { sequence, replies, ...(request ? { request } : {}) };
}

/** Each loaded thread's replies, and its top-level message or task note when that is loaded too. */
function loadedThreads(messages: readonly TeamMessage[]): Map<number, LoadedThread> {
  const threads = new Map<number, LoadedThread>();
  for (const message of messages) {
    if (message.threadSequence === undefined) continue;
    const thread = threads.get(message.threadSequence);
    if (thread) thread.replies.push(message);
    else threads.set(message.threadSequence, { replies: [message] });
  }
  for (const message of messages) {
    const thread = threads.get(message.sequence);
    if (thread) thread.root = message;
  }
  return threads;
}

/**
 * A question pends while the team stores it as pending. A settled one was settled by the first
 * acknowledgement after it: the user replying where it was asked, or the lead resolving it. A
 * question settled under the earlier rule, where any later user message answered it, has only such
 * a reply; one replaced in its thread before anyone answered has no state.
 */
function requestState(
  question: TeamConversationMessage,
  { pending, loaded }: RowContext,
): TeamRequestState | undefined {
  if (pending.has(question.sequence)) return "pending";
  const settled =
    loaded.find((message) => acknowledgesTeamRequest(message, question)) ??
    loaded.find(
      (message) =>
        message.sequence > question.sequence &&
        !isTeamSystemMessage(message) &&
        message.sender.type === "user",
    );
  if (!settled) return undefined;
  return isTeamSystemMessage(settled) ? "answered" : "replied";
}

/**
 * Your messages are the user's own and those for them, and requests are the questions that still
 * need a reply, one per thread; system changes stay in the full view.
 */
function isInView(message: TeamMessage, view: TranscriptView, context: RowContext): boolean {
  if (view === "all") return true;
  if (isTeamSystemMessage(message)) return false;
  if (view === "requests") return message.request === true && context.pending.has(message.sequence);
  return message.sender.type === "user" || isForUser(message, addresseeOf(message, context));
}

function agentRunEntry(
  message: TeamConversationMessage,
  context: RowContext,
  previous?: AgentRunEntry,
): AgentRunEntry {
  const { lead, members } = context;
  const addressee = addresseeOf(message, context);
  const request = message.request ? requestState(message, context) : undefined;
  const replies = context.threads?.get(message.sequence)?.replies;
  return {
    message,
    body: withoutLeadingMentions(message.content, [lead, ...members]),
    addressee,
    request,
    startsRun: !previous,
    showHeader:
      !previous ||
      addressee !== previous.addressee ||
      message.request === true ||
      originKey(message) !== originKey(previous.message),
    collapsible: !isForUser(message, addressee),
    ...(replies ? { thread: transcriptThread(message.sequence, replies, context) } : {}),
  };
}

/** Who an agent's message wakes, by name; none when it's for the user. */
function addresseeOf(
  { content, sender, askedBy, threadSequence }: TeamConversationMessage,
  { lead, members, coordinators, tasksByThread }: RowContext,
): string | undefined {
  const task = threadSequence === undefined ? undefined : tasksByThread.get(threadSequence);
  const audience = resolveTeamAudience({
    content,
    sender,
    lead,
    members,
    askedBy,
    coordinators,
    task,
  });
  // Everyone but the sender reads as "Everyone"; a message that wakes no agent is for the user.
  return audience.length > 0 ? teamAudienceLabel(audience, members.length) : undefined;
}

/** An agent's message that wakes no agent or asks the user something, and every connector's
 *  message, which brings news from outside the team, is for the user. */
function isForUser(message: TeamConversationMessage, addressee: string | undefined): boolean {
  return addressee === undefined || message.request === true || message.sender.type === "connector";
}

/** Who a connector relayed a message from, so a run names each new person. */
function originKey({ origin }: TeamConversationMessage): string | undefined {
  return origin && `${origin.kind}:${origin.requester?.id ?? ""}`;
}

/**
 * Membership changes merge, as do one agent's artifact shares and one opener's quiet task openings;
 * other system messages stand alone.
 */
function systemMessageGroup({ content }: TeamSystemMessage): string | undefined {
  if (content.type === "member_joined" || content.type === "member_left") return content.type;
  if (
    (content.type === "artifact_shared" || content.type === "task_opened") &&
    content.actor.type === "agent"
  ) {
    return `${content.type}:${content.actor.agentId}`;
  }
  return undefined;
}

function isSameDay(left: string, right: string): boolean {
  return new Date(left).toDateString() === new Date(right).toDateString();
}

function tasksByThread(tasks: readonly TeamTask[]): Map<number, TeamTask> {
  return new Map(
    tasks.flatMap((task) => (task.threadSequence ? [[task.threadSequence, task] as const] : [])),
  );
}

function pendingSequences(
  pendingRequests: readonly Pick<TeamPendingRequest, "sequence">[],
): Set<number> {
  return new Set(pendingRequests.map(({ sequence }) => sequence));
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
