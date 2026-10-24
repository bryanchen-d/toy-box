import {
  channelAudienceLabel,
  isChannelSystemMessage,
  resolveChannelAudience,
  withoutLeadingMentions,
  type ChannelAgent,
  type ChannelConversationMessage,
  type ChannelMessage,
  type ChannelSystemMessage,
} from "@channels/model";

// Consecutive messages from one agent within this window share a header.
const RUN_WINDOW_MS = 10 * 60 * 1000;

/**
 * Which messages the transcript shows: all of them, or only the user's own messages and the
 * agent messages for them, which leaves out coordination between agents and system changes.
 */
export type TranscriptView = "all" | "yours";

type TranscriptRowContent =
  | { type: "user"; message: ChannelConversationMessage; thread?: TranscriptThread }
  | { type: "agent"; agentId: string; entries: AgentRunEntry[] }
  | { type: "system"; messages: ChannelSystemMessage[] }
  | {
      type: "thread";
      /** The replies that arrived here, after other rows separated them from their thread. */
      thread: TranscriptThread;
      /** The thread's top-level message, once loaded. */
      root?: ChannelConversationMessage;
    };

/**
 * One transcript row: a user's message, one agent's run, merged system messages, or replies in a
 * thread whose top-level message is further up.
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
 * top-level message has every reply loaded too.
 */
export type TranscriptThread = {
  sequence: number;
  replies: ChannelConversationMessage[];
  request?: ChannelRequestState;
};

/** One message in an agent's run, as its header and body present it. */
export type AgentRunEntry = {
  message: ChannelConversationMessage;
  /** The content without the mentions it opens with, which the addressee names instead. */
  body: string;
  /** The run's first message names its author. */
  startsRun: boolean;
  /** Who the message wakes; absent when it's for the user. */
  addressee?: string;
  request?: ChannelRequestState;
  /** After a run's first message, a header appears only to say something new. */
  showHeader: boolean;
  /** Coordination between agents recedes; messages for the user and requests stay whole. */
  collapsible: boolean;
  /** The replies to this message, when it starts a thread. */
  thread?: TranscriptThread;
};

/** A question the lead flagged stays pending until a later user message acknowledges it. */
export type ChannelRequestState = "pending" | "acknowledged";

type RowContext = {
  lead: ChannelAgent;
  members: readonly ChannelAgent[];
  latestUserSequence: number;
  /** Loaded threads by their top-level message's sequence; absent within one thread's rows. */
  threads?: ReadonlyMap<number, LoadedThread>;
};

type LoadedThread = { root?: ChannelConversationMessage; replies: ChannelConversationMessage[] };

/**
 * The transcript's rows. A user message stands alone, one agent's consecutive messages form a run,
 * and membership changes merge, as do one agent's artifact shares. Replies stay with their thread:
 * they join the row that holds the thread, or else form a thread row where they arrive, so new
 * replies remain in view. Rows never span a day or the start of unread messages, so dividers always
 * fall between rows. Rows form from the messages the view shows, so runs and dividers follow what
 * the reader sees.
 */
export function transcriptRows(
  messages: readonly ChannelMessage[],
  {
    lead,
    members,
    unreadAfter,
    view = "all",
  }: {
    lead: ChannelAgent;
    members: readonly ChannelAgent[];
    /** Where unread messages began on arrival; null or undefined marks none. */
    unreadAfter?: number | null;
    view?: TranscriptView;
  },
): TranscriptRow[] {
  const context: RowContext = {
    lead,
    members,
    latestUserSequence: latestUserSequence(messages),
    threads: loadedThreads(messages),
  };
  return rowsOf(messages, context, { unreadAfter, view });
}

/**
 * One thread as a conversation of its own: its top-level message, then its replies grouped as the
 * transcript groups messages. Requests acknowledge from anywhere in the Channel.
 */
export function threadRows(
  messages: readonly ChannelMessage[],
  sequence: number,
  { lead, members }: { lead: ChannelAgent; members: readonly ChannelAgent[] },
): TranscriptRow[] {
  const context: RowContext = { lead, members, latestUserSequence: latestUserSequence(messages) };
  const thread = messages.filter(
    (message) => message.sequence === sequence || message.threadSequence === sequence,
  );
  return rowsOf(thread, context, { view: "all" });
}

/** Who replied in a thread, each once, most recent first. */
export function threadParticipants(
  replies: readonly ChannelConversationMessage[],
): ChannelConversationMessage["sender"][] {
  const participants = new Map<string, ChannelConversationMessage["sender"]>();
  for (const { sender } of [...replies].reverse()) {
    const key = sender.type === "agent" ? sender.agentId : "user";
    if (!participants.has(key)) participants.set(key, sender);
  }
  return [...participants.values()];
}

function rowsOf(
  messages: readonly ChannelMessage[],
  context: RowContext,
  { unreadAfter, view }: { unreadAfter?: number | null; view: TranscriptView },
): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  let previous: ChannelMessage | undefined;
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
  previous: ChannelMessage | undefined,
  message: ChannelMessage,
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

function startRow(message: ChannelMessage, context: RowContext): TranscriptRowContent {
  if (isChannelSystemMessage(message)) return { type: "system", messages: [message] };
  const thread = threadOf(message, context);
  if (thread) {
    return {
      type: "thread",
      thread: transcriptThread(thread.sequence, [message], context),
      ...(thread.root ? { root: thread.root } : {}),
    };
  }
  const { sender } = message;
  if (sender.type === "agent") {
    return { type: "agent", agentId: sender.agentId, entries: [agentRunEntry(message, context)] };
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
function extendRow(row: TranscriptRow, message: ChannelMessage, context: RowContext): boolean {
  if (row.type === "system" && isChannelSystemMessage(message)) {
    const group = systemMessageGroup(message);
    if (group === undefined || group !== systemMessageGroup(row.messages[0]!)) return false;
    row.messages.push(message);
    return true;
  }
  if (isChannelSystemMessage(message)) return false;
  const thread = threadOf(message, context);
  if (thread) {
    if (row.type === "thread" && row.thread.sequence === thread.sequence) {
      row.thread = transcriptThread(thread.sequence, [...row.thread.replies, message], context);
      return true;
    }
    // A reply below its top-level message is already in its summary.
    return (
      (row.type === "user" && row.message.sequence === thread.sequence) ||
      (row.type === "agent" &&
        row.entries.some((entry) => entry.message.sequence === thread.sequence))
    );
  }
  if (row.type !== "agent") return false;
  if (message.sender.type !== "agent" || message.sender.agentId !== row.agentId) return false;
  const last = row.entries.at(-1)!;
  const gap = Date.parse(message.timestamp) - Date.parse(last.message.timestamp);
  if (gap > RUN_WINDOW_MS) return false;
  row.entries.push(agentRunEntry(message, context, last));
  return true;
}

/** The thread a reply belongs to, when the rows group replies into threads. */
function threadOf(
  { threadSequence: sequence }: ChannelConversationMessage,
  { threads }: RowContext,
): { sequence: number; root?: ChannelConversationMessage } | undefined {
  if (sequence === undefined || !threads) return undefined;
  return { sequence, root: threads.get(sequence)?.root };
}

function transcriptThread(
  sequence: number,
  replies: ChannelConversationMessage[],
  context: RowContext,
): TranscriptThread {
  const question = replies.filter(({ request }) => request).at(-1);
  return {
    sequence,
    replies,
    ...(question ? { request: requestState(question, context) } : {}),
  };
}

/** Each loaded thread's replies, and its top-level message when that is loaded too. */
function loadedThreads(messages: readonly ChannelMessage[]): Map<number, LoadedThread> {
  const threads = new Map<number, LoadedThread>();
  for (const message of messages) {
    if (message.threadSequence === undefined || isChannelSystemMessage(message)) continue;
    const thread = threads.get(message.threadSequence);
    if (thread) thread.replies.push(message);
    else threads.set(message.threadSequence, { replies: [message] });
  }
  for (const message of messages) {
    const thread = threads.get(message.sequence);
    if (thread && !isChannelSystemMessage(message)) thread.root = message;
  }
  return threads;
}

function latestUserSequence(messages: readonly ChannelMessage[]): number {
  return messages.reduce(
    (latest, { sender, sequence }) =>
      sender.type === "user" ? Math.max(latest, sequence) : latest,
    0,
  );
}

function requestState(
  message: ChannelConversationMessage,
  { latestUserSequence }: RowContext,
): ChannelRequestState {
  return message.sequence > latestUserSequence ? "pending" : "acknowledged";
}

/** Your messages are the user's own and those for them; system changes stay in the full view. */
function isInView(message: ChannelMessage, view: TranscriptView, context: RowContext): boolean {
  if (view === "all") return true;
  if (isChannelSystemMessage(message)) return false;
  return message.sender.type === "user" || isForUser(message, addresseeOf(message, context));
}

function agentRunEntry(
  message: ChannelConversationMessage,
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
    showHeader: !previous || addressee !== previous.addressee || request !== undefined,
    collapsible: !isForUser(message, addressee),
    ...(replies ? { thread: transcriptThread(message.sequence, replies, context) } : {}),
  };
}

/** Who an agent's message wakes, by name; none when it's for the user. */
function addresseeOf(
  { content, sender }: ChannelConversationMessage,
  { lead, members }: RowContext,
): string | undefined {
  const audience = resolveChannelAudience({ content, sender, lead, members });
  // Everyone but the sender reads as "Everyone"; a message that wakes no agent is for the user.
  return audience.length > 0 ? channelAudienceLabel(audience, members.length) : undefined;
}

/** An agent's message that wakes no agent, or asks the user something, is for the user. */
function isForUser(message: ChannelConversationMessage, addressee: string | undefined): boolean {
  return addressee === undefined || message.request === true;
}

/** Membership changes merge, as do one agent's artifact shares; other system messages stand alone. */
function systemMessageGroup({ content }: ChannelSystemMessage): string | undefined {
  if (content.type === "member_joined" || content.type === "member_left") return content.type;
  if (content.type === "artifact_shared" && content.actor.type === "agent") {
    return `${content.type}:${content.actor.agentId}`;
  }
  return undefined;
}

function isSameDay(left: string, right: string): boolean {
  return new Date(left).toDateString() === new Date(right).toDateString();
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}
