import { describe, expect, test } from "bun:test";
import {
  describeSubSessions,
  dueWake,
  interruptedReport,
  isReminderDue,
  renderSubSessionBrief,
  subSessionReport,
} from "./subSessions";

describe("sub session summary", () => {
  test("counts an owner's sub sessions, those at work, and those on each node", () => {
    expect(
      describeSubSessions([
        { working: true, node: "brchen-db3" },
        { working: false, node: "brchen-db3" },
        { working: false },
      ]),
    ).toBe("3 sub sessions · 1 working · 2 on brchen-db3");
  });

  test("leaves out work and nodes when none apply", () => {
    expect(describeSubSessions([{ working: false }])).toBe("1 sub session");
  });
});

describe("sub session brief", () => {
  test("names the owner, sets the reporting rules, then gives each part of the brief in order", () => {
    const message = renderSubSessionBrief(
      {
        goal: "Fix the flaky terminal reconnect test.",
        context: "It fails one run in ten on Windows. The PTY closes before the replay ends.",
        deliverable: "A draft pull request link.",
        acceptanceCriteria: ["The test passes 50 runs in a row", "No other test changes"],
        boundaries: "Don't change the PTY protocol.",
        reporting: "Include the 50-run log.",
      },
      { name: "Riley" },
    );

    expect(message).toStartWith("You are a sub session doing one task for Riley,");
    expect(message).toContain("goes to Riley automatically");
    expect(message).toContain("end your turn with the question instead of guessing");
    expect(message).toContain("You can't create sub sessions of your own");
    const headings = [...message.matchAll(/^## (.+)$/gm)].map(([, heading]) => heading);
    expect(headings).toEqual([
      "Goal",
      "Context",
      "Deliverable",
      "Acceptance criteria",
      "Boundaries",
      "Reporting",
    ]);
    expect(message).toContain(
      "## Acceptance criteria\n- The test passes 50 runs in a row\n- No other test changes",
    );
  });

  test("leaves out optional parts it wasn't given and names an unnamed owner by role", () => {
    const message = renderSubSessionBrief(
      {
        goal: "Summarize the open review threads.",
        context: "PR 123.",
        deliverable: "A list of unresolved threads.",
        acceptanceCriteria: ["Every unresolved thread is listed"],
      },
      {},
    );

    expect(message).toStartWith(
      "You are a sub session doing one task for the agent that created you,",
    );
    expect(message).not.toContain("## Boundaries");
    expect(message).not.toContain("## Reporting");
    expect(message).not.toContain("separate machine");
  });

  test("on a node, asks for its work on its own branch, pushed at each milestone and reported", () => {
    const message = renderSubSessionBrief(
      {
        goal: "Check the Settings page renders.",
        context: "bryanchen-d/toy-box main.",
        deliverable: "A screenshot path.",
        acceptanceCriteria: ["The page shows every section"],
      },
      { name: "Riley", node: "brchen-db3" },
    );

    expect(message).toContain("You run on brchen-db3, a separate machine, in an empty folder");
    expect(message).toContain(
      "commit and push at each milestone, naming the branch and its last pushed commit in every report",
    );
  });
});

describe("interrupted report", () => {
  test("gives the owner its reason and the brief, to redo the task elsewhere", () => {
    expect(
      interruptedReport(
        "brchen-db3 is out of reach.",
        {
          goal: "Check the Settings page.",
          context: "main.",
          deliverable: "A screenshot.",
          acceptanceCriteria: ["Every section shows"],
        },
        ["push commits to a remote: git push origin check"],
      ),
    ).toEqual({
      outcome: "interrupted",
      report: "brchen-db3 is out of reach.",
      externalWrites: ["push commits to a remote: git push origin check"],
      brief:
        "## Goal\nCheck the Settings page.\n\n## Context\nmain.\n\n## Deliverable\nA screenshot.\n\n## Acceptance criteria\n- Every section shows",
    });
    expect(interruptedReport("Agent Teams restarted.", undefined)).toEqual({
      outcome: "interrupted",
      report: "Agent Teams restarted.",
    });
  });
});

describe("sub session report", () => {
  test("is the final answer of a finished execution", () => {
    expect(subSessionReport({ status: "completed", response: "  Opened PR 42.  " })).toEqual({
      outcome: "completed",
      report: "Opened PR 42.",
    });
  });

  test("is nothing when the execution has no answer or answers exactly NO_UPDATE", () => {
    expect(subSessionReport({ status: "completed" })).toBeUndefined();
    expect(subSessionReport({ status: "completed", response: "   " })).toBeUndefined();
    expect(subSessionReport({ status: "completed", response: " NO_UPDATE\n" })).toBeUndefined();
    expect(
      subSessionReport({ status: "completed", response: "NO_UPDATE yet, CI is still running" }),
    ).toMatchObject({ outcome: "completed" });
    expect(subSessionReport({ status: "timed_out", response: "Partial" })).toBeUndefined();
  });

  test("reports a failure with its error, or says it stopped without one", () => {
    expect(subSessionReport({ status: "failed", error: "Usage limit reached." })).toEqual({
      outcome: "failed",
      report: "Usage limit reached.",
    });
    expect(subSessionReport({ status: "failed" })).toEqual({
      outcome: "failed",
      report: "It stopped without saying why.",
    });
  });

  test("cuts a very long answer and says so", () => {
    const { report } = subSessionReport({ status: "completed", response: "x".repeat(25_000) })!;
    expect(report).toStartWith("x".repeat(20_000));
    expect(report).toEndWith("(The report was cut at 20000 characters.)");
  });

  test("lists its external writes, and reports them even when it has nothing else to say", () => {
    const writes = ["push commits to a remote: git push origin fix"];
    expect(subSessionReport({ status: "completed", response: "Opened PR 42." }, writes)).toEqual({
      outcome: "completed",
      report: "Opened PR 42.",
      externalWrites: writes,
    });
    expect(subSessionReport({ status: "completed", response: "NO_UPDATE" }, writes)).toEqual({
      outcome: "completed",
      report: "It had nothing else to report.",
      externalWrites: writes,
    });
    expect(subSessionReport({ status: "failed", error: "CI failed." }, writes)).toEqual({
      outcome: "failed",
      report: "CI failed.",
      externalWrites: writes,
    });
  });
});

describe("sub session wake", () => {
  const wake = { at: "2026-11-14T10:00:00.000Z", reason: "CI on PR 42" };

  test("is due from its scheduled time on", () => {
    expect(dueWake({ wake }, new Date("2026-11-14T09:59:59.000Z"))).toBeUndefined();
    expect(dueWake({ wake }, new Date("2026-11-14T10:00:00.000Z"))).toEqual(wake);
    expect(dueWake({ wake }, new Date("2026-11-15T00:00:00.000Z"))).toEqual(wake);
  });

  test("is nothing when the metadata holds no readable wake", () => {
    const now = new Date("2026-11-15T00:00:00.000Z");
    expect(dueWake(undefined, now)).toBeUndefined();
    expect(dueWake({}, now)).toBeUndefined();
    expect(dueWake({ wake: { at: "soon", reason: "CI" } }, now)).toBeUndefined();
    expect(dueWake("wake", now)).toBeUndefined();
  });
});

describe("sub session reminder", () => {
  const remindAt = "2026-11-15T10:00:00.000Z";

  test("is due from its time on, unless the sub session is waiting on its own wake", () => {
    expect(isReminderDue({ remindAt }, new Date("2026-11-15T09:59:59.000Z"))).toBe(false);
    expect(isReminderDue({ remindAt }, new Date("2026-11-15T10:00:00.000Z"))).toBe(true);
    const wake = { at: "2026-11-16T10:00:00.000Z", reason: "a review" };
    expect(isReminderDue({ remindAt, wake }, new Date("2026-11-16T00:00:00.000Z"))).toBe(false);
  });

  test("is never due without a readable reminder", () => {
    const now = new Date("2026-11-16T00:00:00.000Z");
    expect(isReminderDue(undefined, now)).toBe(false);
    expect(isReminderDue({}, now)).toBe(false);
    expect(isReminderDue({ remindAt: "tomorrow" }, now)).toBe(false);
  });
});
