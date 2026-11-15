import { describe, expect, test } from "bun:test";
import { dueWake, isReminderDue, renderSubSessionBrief, subSessionReport } from "./subSessions";

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
