import { describe, expect, test } from "bun:test";
import { renderSubSessionBrief } from "./subSessions";

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
