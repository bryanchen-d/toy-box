import { describe, expect, test } from "bun:test";
import type { ChannelConversationMessage, ChannelMessage } from "@channels/model";
import {
  pendingRequestRow,
  threadParticipants,
  threadRows,
  transcriptDayLabel,
  transcriptRows,
  type AgentRunEntry,
  type TranscriptRow,
} from "./transcriptRows";

// Local wall-clock times keep day boundaries independent of the test machine's time zone.
function at(day: number, hour: number, minute: number): string {
  return new Date(2026, 8, day, hour, minute).toISOString();
}

function agentPost(
  sequence: number,
  agentId: string,
  timestamp = at(26, 10, sequence),
  content = `Update ${sequence}`,
): ChannelConversationMessage {
  const sender = { type: "agent", agentId } as const;
  return { id: `${sequence}`, sequence, timestamp, sender, content };
}

function userPost(sequence: number, timestamp = at(26, 10, sequence)): ChannelMessage {
  return { id: `${sequence}`, sequence, timestamp, sender: { type: "user" }, content: "Thanks" };
}

function event(
  sequence: number,
  content: Extract<ChannelMessage, { sender: { type: "system" } }>["content"],
): ChannelMessage {
  return {
    id: `${sequence}`,
    sequence,
    timestamp: at(26, 9, 0),
    sender: { type: "system" },
    content,
  };
}

const lead = { id: "lead", name: "Lead" };
const members = [
  { id: "engine", name: "Engine" },
  { id: "files", name: "Files" },
];
const rowsOf = (messages: ChannelMessage[], unreadAfter?: number) =>
  transcriptRows(messages, { lead, members, unreadAfter });

const rowIds = (rows: TranscriptRow[]) =>
  rows.map((row) => {
    switch (row.type) {
      case "user":
        return [row.message.id];
      case "agent":
        return row.entries.map(({ message }) => message.id);
      case "system":
        return row.messages.map(({ id }) => id);
      case "thread":
        return row.thread.replies.map(({ id }) => id);
    }
  });

/** The entries of a transcript that is one agent's run. */
function runOf(messages: ChannelMessage[]): AgentRunEntry[] {
  const [row] = rowsOf(messages);
  if (row?.type !== "agent") throw new Error("Expected an agent run.");
  return row.entries;
}

const member = { channelId: "channel", id: "files", name: "Files" };

describe("transcript rows", () => {
  test("one agent's consecutive messages share a row", () => {
    const messages = [
      agentPost(1, "engine", at(26, 10, 0)),
      agentPost(2, "engine", at(26, 10, 9)),
      agentPost(3, "lead", at(26, 10, 10)),
      agentPost(4, "engine", at(26, 10, 11)),
    ];
    expect(rowIds(rowsOf(messages))).toEqual([["1", "2"], ["3"], ["4"]]);
  });

  test("a run breaks after ten minutes, at midnight, and where unread messages begin", () => {
    expect(
      rowIds(
        rowsOf([agentPost(1, "engine", at(26, 10, 0)), agentPost(2, "engine", at(26, 10, 11))]),
      ),
    ).toEqual([["1"], ["2"]]);
    expect(
      rowIds(
        rowsOf([agentPost(1, "engine", at(26, 23, 58)), agentPost(2, "engine", at(27, 0, 3))]),
      ),
    ).toEqual([["1"], ["2"]]);
    expect(
      rowIds(
        rowsOf([agentPost(1, "engine", at(26, 10, 0)), agentPost(2, "engine", at(26, 10, 1))], 1),
      ),
    ).toEqual([["1"], ["2"]]);
  });

  test("a row keeps its first message's identity as later messages join it", () => {
    const rows = rowsOf([agentPost(1, "engine"), agentPost(2, "engine")]);
    expect(rows.map(({ key }) => key)).toEqual(["1"]);
  });

  test("user messages stand alone", () => {
    const messages = [userPost(1, at(26, 10, 0)), userPost(2, at(26, 10, 1))];
    expect(rowIds(rowsOf(messages))).toEqual([["1"], ["2"]]);
  });

  test("membership changes merge while a question remains an ordinary agent message", () => {
    const messages = [
      event(1, { type: "member_joined", member }),
      event(2, { type: "member_joined", member: { ...member, id: "engine", name: "Engine" } }),
      { ...agentPost(3, "lead", at(26, 9, 1)), request: true as const },
    ];
    expect(rowIds(rowsOf(messages))).toEqual([["1", "2"], ["3"]]);
  });

  test("only consecutive artifact shares from the same agent merge", () => {
    const artifact = { file: { kind: "machine" as const, path: "/plan.md" }, title: "Plan" };
    const messages = ["engine", "engine", "files", undefined, undefined].map((agentId, index) =>
      event(index + 1, {
        type: "artifact_shared",
        actor: agentId ? { type: "agent", agentId } : { type: "user" },
        artifact,
      }),
    );
    expect(rowIds(rowsOf(messages))).toEqual([["1", "2"], ["3"], ["4"], ["5"]]);
  });
});

describe("transcript dividers", () => {
  test("a day divider precedes the first row and each row that begins a new day", () => {
    const rows = rowsOf([
      agentPost(1, "engine", at(26, 23, 50)),
      userPost(2, at(26, 23, 55)),
      agentPost(3, "engine", at(27, 0, 5)),
    ]);
    expect(rows.map(({ divider }) => divider?.day?.getDate())).toEqual([26, undefined, 27]);
  });

  test("the New rule precedes the first unread row, unless nothing loaded comes before it", () => {
    const messages = [userPost(1), agentPost(2, "lead"), agentPost(3, "lead")];
    expect(rowsOf(messages, 2).map(({ divider }) => divider?.unread ?? false)).toEqual([
      false,
      false,
      true,
    ]);
    expect(rowsOf(messages, 0).some(({ divider }) => divider?.unread)).toBe(false);
  });

  test("a day and the unread messages beginning together share one divider", () => {
    const rows = rowsOf(
      [agentPost(1, "lead", at(26, 18, 0)), agentPost(2, "lead", at(27, 8, 0))],
      1,
    );
    expect(rows[1]!.divider).toEqual({ day: new Date(at(27, 8, 0)), unread: true });
  });
});

describe("agent run entries", () => {
  test("an entry names who it wakes, and none when it's for the user", () => {
    const addressee = (agentId: string, content: string) =>
      runOf([agentPost(1, agentId, undefined, content)])[0]!.addressee;
    expect(addressee("lead", "@engine Build the lift.")).toBe("Engine");
    expect(addressee("engine", "Lift built.")).toBe("Lead");
    expect(addressee("lead", "@everyone Standup.")).toBe("Everyone");
    expect(addressee("lead", "The lift is ready.")).toBeUndefined();
  });

  test("the body drops the mentions it opens with, since the addressee names them", () => {
    const [entry] = runOf([agentPost(1, "lead", undefined, "@engine Build the lift.")]);
    expect(entry!.body).toBe("Build the lift.");
    expect(entry!.message.content).toBe("@engine Build the lift.");
  });

  test("only a run's first message names its author", () => {
    const run = runOf([agentPost(1, "lead"), agentPost(2, "lead")]);
    expect(run.map(({ startsRun }) => startsRun)).toEqual([true, false]);
  });

  test("after the first, a header appears only when the addressee changes or the lead asks", () => {
    const run = runOf([
      agentPost(1, "lead", undefined, "@engine Build the lift."),
      agentPost(2, "lead", undefined, "@engine Then the stairs."),
      agentPost(3, "lead", undefined, "@files Index the plans."),
      { ...agentPost(4, "lead", undefined, "@files Which plan?"), request: true },
    ]);
    expect(run.map(({ showHeader }) => showHeader)).toEqual([true, false, true, true]);
  });

  test("coordination between agents collapses; messages for the user and requests stay whole", () => {
    const run = runOf([
      agentPost(1, "lead", undefined, "@engine Build the lift."),
      agentPost(2, "lead", undefined, "The lift is ready."),
      { ...agentPost(3, "lead", undefined, "@engine Which floor?"), request: true },
    ]);
    expect(run.map(({ collapsible }) => collapsible)).toEqual([true, false, false]);
  });

  test("a request stays pending until a later user message acknowledges it", () => {
    const asked = { ...agentPost(1, "lead"), request: true as const };
    expect(runOf([asked])[0]!.request).toBe("pending");
    expect(runOf([asked, userPost(3)])[0]!.request).toBe("acknowledged");
  });

  test("a later request pends while an earlier reply keeps acknowledging its own", () => {
    const rows = rowsOf([
      { ...agentPost(1, "lead"), request: true },
      userPost(3),
      { ...agentPost(4, "lead"), request: true },
    ]);
    const requests = rows.flatMap((row) =>
      row.type === "agent" ? row.entries.map(({ request }) => request) : [],
    );
    expect(requests).toEqual(["acknowledged", "pending"]);
  });
});

describe("your messages view", () => {
  const yours = (messages: ChannelMessage[], unreadAfter?: number) =>
    transcriptRows(messages, { lead, members, unreadAfter, view: "yours" });

  test("shows the user's messages and agent messages for them", () => {
    const messages = [
      userPost(1),
      agentPost(2, "lead", undefined, "The lift is ready."),
      agentPost(3, "lead", undefined, "@engine Build the stairs."),
      agentPost(4, "lead", undefined, "@everyone Standup."),
      agentPost(5, "engine", undefined, "Stairs built."),
      event(6, { type: "member_joined", member }),
    ];
    expect(rowIds(yours(messages))).toEqual([["1"], ["2"]]);
  });

  test("a request stays, even when it also addresses agents", () => {
    const asked = {
      ...agentPost(1, "lead", undefined, "@engine Which floor?"),
      request: true as const,
    };
    expect(rowIds(yours([asked]))).toEqual([["1"]]);
  });

  test("an agent's messages for the user form one run across the coordination between them", () => {
    const rows = yours([
      agentPost(1, "lead", undefined, "The lift is ready."),
      agentPost(2, "engine", undefined, "Stairs next?"),
      agentPost(3, "lead", undefined, "@engine Yes."),
      agentPost(4, "lead", undefined, "The stairs are next."),
    ]);
    expect(rowIds(rows)).toEqual([["1", "4"]]);
  });

  test("the New rule precedes the first unread message the view shows", () => {
    const rows = yours(
      [
        userPost(1),
        agentPost(2, "lead", undefined, "@engine Build the lift."),
        agentPost(3, "lead", undefined, "The lift is ready."),
      ],
      1,
    );
    expect(rows.map(({ divider }) => divider?.unread ?? false)).toEqual([false, true]);
  });
});

describe("threads", () => {
  function reply(
    sequence: number,
    threadSequence: number,
    agentId?: string,
    content = `Reply ${sequence}`,
  ): ChannelConversationMessage {
    const base = agentId ? agentPost(sequence, agentId, undefined, content) : userPost(sequence);
    return { ...(base as ChannelConversationMessage), threadSequence };
  }
  const threadOfRow = (row: TranscriptRow | undefined) => {
    if (row?.type === "user") return row.thread;
    if (row?.type === "agent") return row.entries[0]!.thread;
    if (row?.type === "thread") return row.thread;
  };
  const replyIds = (row: TranscriptRow | undefined) =>
    threadOfRow(row)?.replies.map(({ id }) => id);

  test("replies right below their top-level message join its row's thread", () => {
    const rows = rowsOf([userPost(1), reply(2, 1, "lead"), reply(3, 1, "engine")]);
    expect(rowIds(rows)).toEqual([["1"]]);
    expect(replyIds(rows[0])).toEqual(["2", "3"]);
  });

  test("an agent's run holds the threads of each of its messages", () => {
    const rows = rowsOf([agentPost(1, "lead"), agentPost(2, "lead"), reply(3, 1, "engine")]);
    expect(rowIds(rows)).toEqual([["1", "2"]]);
    expect(replyIds(rows[0])).toEqual(["3"]);
  });

  test("replies separated from their thread form one thread row where they arrive", () => {
    const rows = rowsOf([
      userPost(1),
      agentPost(2, "engine"),
      reply(3, 1, "lead"),
      reply(4, 1, "engine"),
    ]);
    expect(rowIds(rows)).toEqual([["1"], ["2"], ["3", "4"]]);
    expect(rows[2]).toMatchObject({ type: "thread", root: { id: "1" } });
    expect(replyIds(rows[0])).toEqual(["3", "4"]);
  });

  test("replies to different threads interleave as separate thread rows", () => {
    const rows = rowsOf([userPost(1), userPost(2), reply(3, 1), reply(4, 2), reply(5, 1)]);
    expect(rowIds(rows)).toEqual([["1"], ["2"], ["3"], ["4"], ["5"]]);
    expect(replyIds(rows[0])).toEqual(["3", "5"]);
  });

  test("unread replies begin below the New rule, even right below their thread", () => {
    const rows = rowsOf([userPost(1), reply(2, 1, "lead")], 1);
    expect(rowIds(rows)).toEqual([["1"], ["2"]]);
    expect(rows[1]).toMatchObject({ type: "thread", divider: { unread: true } });
  });

  test("a thread row names its top-level message only once that is loaded", () => {
    const [row] = rowsOf([reply(5, 1, "lead")]);
    expect(row).toMatchObject({ type: "thread", thread: { sequence: 1 } });
    expect(row).not.toHaveProperty("root");
  });

  test("a question in a thread pends until a later user message anywhere", () => {
    const asked = { ...reply(3, 1, "lead"), request: true as const };
    const pending = rowsOf([userPost(1), agentPost(2, "engine"), asked]);
    expect(threadOfRow(pending[0])?.request).toBe("pending");
    expect(threadOfRow(pending[2])?.request).toBe("pending");
    const acknowledged = rowsOf([userPost(1), agentPost(2, "engine"), asked, userPost(4)]);
    expect(threadOfRow(acknowledged[2])?.request).toBe("acknowledged");
  });

  test("your messages view keeps replies for the user and leaves coordination out", () => {
    const rows = transcriptRows(
      [
        userPost(1),
        agentPost(2, "engine"),
        reply(3, 1, "lead", "@engine Take this."),
        reply(4, 1, "lead", "It's done."),
      ],
      { lead, members, view: "yours" },
    );
    expect(rowIds(rows)).toEqual([["1"]]);
    expect(replyIds(rows[0])).toEqual(["3", "4"]);
  });

  test("a thread's own rows begin with its top-level message and group replies as runs", () => {
    const messages = [
      userPost(1),
      agentPost(2, "engine"),
      reply(3, 1, "lead"),
      reply(4, 1, "lead"),
      reply(5, 1),
      reply(6, 2, "lead"),
    ];
    const rows = threadRows(messages, 1, { lead, members });
    expect(rowIds(rows)).toEqual([["1"], ["3", "4"], ["5"]]);
    expect(rows.every((row) => threadOfRow(row) === undefined)).toBe(true);
  });

  test("participants are listed once each, most recent first", () => {
    const participants = threadParticipants([
      reply(2, 1, "lead"),
      reply(3, 1, "engine"),
      reply(4, 1, "lead"),
      reply(5, 1),
    ]);
    expect(participants).toEqual([
      { type: "user" },
      { type: "agent", agentId: "lead" },
      { type: "agent", agentId: "engine" },
    ]);
  });
});

describe("pending request row", () => {
  const rows = rowsOf([
    userPost(1),
    agentPost(2, "lead"),
    { ...agentPost(3, "lead"), request: true },
  ]);

  test("locates the canonical pending question within an agent run", () => {
    expect(pendingRequestRow(rows, 3)).toEqual({ sequence: 3, index: 1 });
  });

  test("has no placement after acknowledgement or outside loaded history", () => {
    expect(pendingRequestRow(rows, null)).toBeUndefined();
    expect(pendingRequestRow(rows, 9)).toBeUndefined();
  });
});

describe("transcript day labels", () => {
  const now = new Date(2026, 8, 28, 20, 0);

  test("recent days are named relatively and older ones in full", () => {
    expect(transcriptDayLabel(new Date(2026, 8, 28, 1, 0), now)).toBe("Today");
    expect(transcriptDayLabel(new Date(2026, 8, 27, 23, 0), now)).toBe("Yesterday");
    expect(transcriptDayLabel(new Date(2026, 8, 26, 8, 0), now)).toContain("September 26");
  });

  test("a day from another year includes the year", () => {
    expect(transcriptDayLabel(new Date(2025, 8, 26, 8, 0), now)).toContain("2025");
  });
});
