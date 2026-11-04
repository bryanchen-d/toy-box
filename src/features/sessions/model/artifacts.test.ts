import { expect, test } from "bun:test";
import { orderSessionArtifacts } from "./artifacts";

test("pins keep their order ahead of newer and newly edited session artifacts", () => {
  const artifacts = [
    { path: "plan.md", updatedAt: 1 },
    { path: "spec.md", updatedAt: 2 },
    { path: "notes.md", updatedAt: 100 },
    { path: "new.md", updatedAt: 200 },
  ];
  const ordered = orderSessionArtifacts(artifacts, ["spec.md", "plan.md"]);
  expect(ordered.map(({ path }) => path)).toEqual(["spec.md", "plan.md", "new.md", "notes.md"]);
  expect(ordered.slice(0, 2).every(({ pinned }) => pinned)).toBe(true);
  expect(ordered.slice(2).some(({ pinned }) => pinned)).toBe(false);
  expect(orderSessionArtifacts(artifacts, ["plan.md"]).map(({ path }) => path)).toEqual([
    "plan.md",
    "new.md",
    "notes.md",
    "spec.md",
  ]);
  expect(artifacts[0]).not.toHaveProperty("pinned");
});

test("missing pinned files stay out of the list and reappear pinned when regenerated", () => {
  expect(orderSessionArtifacts([{ path: "notes.md", updatedAt: 2 }], ["plan.md"])).toEqual([
    { path: "notes.md", updatedAt: 2 },
  ]);
  expect(orderSessionArtifacts([{ path: "plan.md", updatedAt: 3 }], ["plan.md"])).toEqual([
    { path: "plan.md", updatedAt: 3, pinned: true },
  ]);
});
