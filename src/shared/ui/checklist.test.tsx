import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Checklist, type ChecklistFilter, type ChecklistItem } from "./checklist";

const render = (items: ChecklistItem[], show?: ChecklistFilter) =>
  renderToStaticMarkup(<Checklist items={items} show={show} empty={<p>Nothing shown</p>} />);

test("labels every status for assistive tech", () => {
  const html = render([
    { id: "a", title: "Plan", status: "pending" },
    { id: "b", title: "Build", status: "in_progress" },
    { id: "c", title: "Ship", status: "blocked" },
    { id: "d", title: "Review", status: "in_review" },
    { id: "e", title: "Scope", status: "done" },
    { id: "f", title: "Port", status: "cancelled" },
    { id: "g", title: "Polish", status: "deferred" },
    { id: "h", title: "Theme", status: "cut" },
    { id: "i", title: "Docs", status: "duplicate" },
  ]);

  for (const label of [
    "Pending",
    "In progress",
    "Blocked",
    "In review",
    "Done",
    "Cancelled",
    "Deferred",
    "Cut",
    "Duplicate",
  ]) {
    expect(html).toContain(`aria-label="${label}"`);
  }
});

test("items set aside count as finished, start collapsed, and read muted like done ones", () => {
  const html = render([
    {
      id: "release",
      title: "Release",
      status: "in_progress",
      children: [
        { id: "ship", title: "Ship", status: "done" },
        { id: "port", title: "Port", status: "cancelled" },
        { id: "docs", title: "Docs", status: "pending" },
      ],
    },
    {
      id: "polish",
      title: "Polish",
      status: "deferred",
      children: [{ id: "hidden", title: "Tweak the theme", status: "pending" }],
    },
  ]);

  expect(html).toContain('aria-label="2 of 3 subtasks finished"');
  expect(html).not.toContain("Tweak the theme");
});

test("a cited ID precedes the title", () => {
  const html = render([{ id: "t12", displayId: "t12", title: "Parser", status: "pending" }]);
  expect(html.indexOf(">t12<")).toBeGreaterThan(-1);
  expect(html.indexOf(">t12<")).toBeLessThan(html.indexOf("Parser"));
});

test("starts done parents collapsed without hiding their supporting actions", () => {
  const html = render([
    {
      id: "done",
      title: "Research",
      status: "done",
      detail: <button type="button">Open report</button>,
      children: [{ id: "hidden", title: "Read the docs", status: "done" }],
    },
    {
      id: "open",
      title: "Build",
      status: "in_progress",
      children: [
        { id: "shown", title: "Write the parser", status: "pending" },
        {
          id: "finished",
          title: "Design",
          status: "done",
          children: [{ id: "nested", title: "Review", status: "done" }],
        },
      ],
    },
  ]);

  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain('aria-expanded="true"');
  expect(html).not.toContain("Read the docs");
  expect(html).toContain("Write the parser");
  expect(html).toContain("Open report");
  expect(html).toContain('aria-label="Subtasks of Research"');
  expect(html).toContain('aria-label="1 of 2 subtasks finished"');
});

const open: ChecklistFilter = ({ status }) => status !== "done";

test("a filter hides items while their parents keep counting every subtask", () => {
  const html = render(
    [
      { id: "shipped", title: "Ship", status: "done" },
      {
        id: "build",
        title: "Build",
        status: "in_progress",
        children: [
          { id: "parser", title: "Write the parser", status: "pending" },
          { id: "design", title: "Design", status: "done" },
        ],
      },
    ],
    open,
  );

  expect(html).not.toContain("Ship");
  expect(html).not.toContain("Design");
  expect(html).toContain("Write the parser");
  expect(html).toContain('aria-label="1 of 2 subtasks finished"');
});

test("a done parent stays open as context for a subtask the filter shows", () => {
  const html = render(
    [
      {
        id: "research",
        title: "Research",
        status: "done",
        children: [{ id: "follow-up", title: "Follow up", status: "blocked" }],
      },
    ],
    open,
  );

  expect(html).toContain("Research");
  expect(html).toContain('aria-expanded="true"');
  expect(html).toContain("Follow up");
});

test("a parent offers no disclosure when the filter hides every subtask", () => {
  const html = render(
    [
      {
        id: "build",
        title: "Build",
        status: "in_progress",
        children: [{ id: "design", title: "Design", status: "done" }],
      },
    ],
    open,
  );

  expect(html).toContain('aria-label="1 of 1 subtasks finished"');
  expect(html).not.toContain("aria-expanded");
});

test("shows its empty content when the filter leaves nothing", () => {
  expect(render([{ id: "shipped", title: "Ship", status: "done" }], open)).toBe(
    "<p>Nothing shown</p>",
  );
});

test("a selectable row is one button for the whole row, beside its own controls", () => {
  const html = render([
    {
      id: "build",
      title: "Build",
      status: "in_progress",
      detail: <button type="button">Open report</button>,
      select: { label: "Show latest message about Build", onSelect: () => {} },
    },
  ]);

  expect(html).toContain('aria-label="Show latest message about Build"');
  expect(html).toContain("Open report");
});
