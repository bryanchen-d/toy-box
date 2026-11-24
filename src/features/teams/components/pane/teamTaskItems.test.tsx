import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { teamLead, teamTaskTree } from "@teams/model";
import { teamTask } from "@teams/model/testFixtures";
import { Checklist } from "@/shared/ui/checklist";
import { TaskCard, teamTaskStatusLabel } from "./TaskCard";
import { teamTaskItems } from "./teamTaskItems";

test.each([
  { added: 12_345, removed: 0, addedText: "+12.3K", removedText: "\u22120" },
  { added: 0, removed: 12_345, addedText: "+0", removedText: "\u221212.3K" },
])(
  "collapsed parents show compact totals and retain the zero side: %j",
  ({ added, removed, addedText, removedText }) => {
    const items = teamTaskItems({
      tasks: teamTaskTree([
        teamTask("t1", { title: "Release", status: "completed" }),
        teamTask("t2", {
          parentId: "t1",
          title: "Build",
          status: "completed",
          diff: { added, removed },
        }),
      ]),
      owners: [],
      artifacts: [],
      onArtifactOpen: () => {},
    });
    const html = renderToStaticMarkup(<Checklist items={items} />);
    const label = `${added} lines added, ${removed} lines removed`;
    expect(html).toContain(`>${addedText}</span>`);
    expect(html).toContain(`>${removedText}</span>`);
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain(`title="${label}"`);
  },
);

test("pending tasks keep their titles without displaying reported diff counts", () => {
  const items = teamTaskItems({
    tasks: teamTaskTree([
      teamTask("t1", { title: "Queued", diff: { added: 0, removed: 0 } }),
      teamTask("t2", { position: 1, title: "Next", diff: { added: 12, removed: 3 } }),
    ]),
    owners: [],
    artifacts: [],
    onArtifactOpen: () => {},
  });
  const html = renderToStaticMarkup(<Checklist items={items} />);
  expect(html).toContain("Queued");
  expect(html).toContain("Next");
  expect(html).not.toContain("lines added");
  expect(html).not.toContain("lines removed");
});

test("artifact icons belong to their task, not its parents, and omit visible titles", () => {
  const items = teamTaskItems({
    tasks: teamTaskTree([
      teamTask("t1", { title: "Release", status: "completed" }),
      teamTask("t2", {
        parentId: "t1",
        title: "Plan",
        status: "completed",
        artifactId: "machine:/project/brief.md",
      }),
      teamTask("t3", {
        position: 1,
        title: "Review",
        status: "completed",
        artifactId: "machine:/missing.md",
      }),
    ]),
    owners: [],
    artifacts: [
      {
        id: "machine:/project/brief.md",
        file: { kind: "machine", path: "/project/brief.md" },
        title: "Project brief",
        sharedAt: "2026-10-06T00:00:00Z",
      },
    ],
    onArtifactOpen: () => {},
  });
  const collapsed = renderToStaticMarkup(<Checklist items={items} />);
  expect(collapsed).not.toContain("Project brief");
  expect(collapsed).toContain('aria-label="Artifact unavailable"');
  expect(collapsed).toContain('disabled=""');
  const html = renderToStaticMarkup(<Checklist items={items[0]!.children!} />);
  expect(html).toContain('aria-label="Open Project brief"');
  expect(html).toContain('title="Project brief"');
  expect(html).not.toContain(">Project brief<");
});

test("each status keeps its own mark, and rows show the ID readers cite", () => {
  const statuses = [
    "pending",
    "in_progress",
    "blocked",
    "in_review",
    "completed",
    "cancelled",
    "deferred",
    "cut",
    "duplicate",
  ] as const;
  const items = teamTaskItems({
    tasks: teamTaskTree(
      statuses.map((status, position) => teamTask(`t${position + 1}`, { position, status })),
    ),
    owners: [],
    artifacts: [],
    onArtifactOpen: () => {},
  });
  expect(items.map(({ displayId, status }) => [displayId, status])).toEqual([
    ["t1", "pending"],
    ["t2", "in_progress"],
    ["t3", "blocked"],
    ["t4", "in_review"],
    ["t5", "done"],
    ["t6", "cancelled"],
    ["t7", "deferred"],
    ["t8", "cut"],
    ["t9", "duplicate"],
  ]);
});

test("a task's card shows its record and says how it closed", () => {
  const owners = [teamLead("team"), { id: "builder", name: "Builder" }];
  const [parent] = teamTaskTree([
    teamTask("t1", {
      title: "Ship the parser",
      description: "## Why\nUsers asked for it.",
      status: "deferred",
      priority: "high",
      assigneeId: "builder",
      artifactId: "machine:/brief.md",
    }),
    teamTask("t2", { parentId: "t1", status: "completed", diff: { added: 12_345, removed: 6 } }),
    teamTask("t3", { parentId: "t1", position: 1 }),
  ]);
  const html = renderToStaticMarkup(
    <TaskCard
      task={parent!}
      owners={owners}
      artifacts={[
        {
          id: "machine:/brief.md",
          file: { kind: "machine", path: "/brief.md" },
          title: "Parser brief",
          sharedAt: "2026-11-24T00:00:00Z",
        },
      ]}
    />,
  );
  for (const text of [
    "t1",
    "Closed as deferred",
    "High priority",
    "Ship the parser",
    "Users asked for it.",
    "Builder",
    "Parser brief",
    "+12345",
    "\u22126",
    "1 of 2 closed",
  ]) {
    expect(html).toContain(text);
  }
  expect(teamTaskStatusLabel("in_review")).toBe("In review");
  const unassigned = renderToStaticMarkup(
    <TaskCard task={{ ...teamTask("t4"), children: [] }} owners={owners} artifacts={[]} />,
  );
  expect(unassigned).toContain("Unassigned");
  expect(unassigned).toContain("Pending");
});

test("an assignee running a turn woken for its task shows as working on it now", () => {
  const owners = [teamLead("team"), { id: "builder", name: "Builder" }];
  const tasks = teamTaskTree([
    teamTask("t1", { title: "Parser", status: "in_progress", assigneeId: "builder" }),
    teamTask("t2", { position: 1, title: "Docs", status: "in_progress", assigneeId: "builder" }),
  ]);
  const items = teamTaskItems({
    tasks,
    owners,
    artifacts: [],
    presence: { builder: { state: "working", tasks: ["t1"] } },
    onArtifactOpen: () => {},
  });
  const html = renderToStaticMarkup(<Checklist items={items} />);
  expect(html).toContain('aria-label="Builder · Working now"');
  expect(html.match(/Working now/g)).toHaveLength(1);
  expect(renderToStaticMarkup(<>{items[0]!.card}</>)).toContain("Working now");
  expect(renderToStaticMarkup(<>{items[1]!.card}</>)).not.toContain("Working now");
});
