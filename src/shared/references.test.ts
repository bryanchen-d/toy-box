import { describe, expect, test } from "bun:test";
import { decodeReference, encodeReference, splitReferences, type Reference } from "./references";

describe("references", () => {
  test("host-defined kinds share one encoding independent of completion triggers", () => {
    for (const kind of ["session", "file", "issue", "design.component"]) {
      const reference = { kind, target: "opaque:id/100%", label: "A label" };
      const source = `[A label](${kind}:opaque:id/100%25)`;
      expect(encodeReference(reference)).toBe(source);
      expect(decodeReference(source)).toEqual(reference);
    }
  });

  test("round-trips targets and literal label punctuation", () => {
    for (const target of [
      "copilot:opaque(id)/100%\u{1f9e9}",
      "src/a file [v2](final)%.tsx",
      "/tmp/\u00e9/notes.md",
      "C:\\Work\\plan.md",
    ]) {
      const reference: Reference = {
        kind: "resource",
        target,
        label: 'Planning [round two] \\ <label> &amp; "quoted"',
      };
      expect(decodeReference(encodeReference(reference))).toEqual(reference);
    }
  });

  test("targets escape only what a Markdown link destination cannot carry", () => {
    expect(
      encodeReference({ kind: "file", target: "src/a folder/plan (v2).md", label: "plan" }),
    ).toBe("[plan](file:src/a%20folder/plan%20%28v2%29.md)");
    expect(encodeReference({ kind: "file", target: "C:\\plan.md", label: "plan" })).toBe(
      "[plan](file:C:%5Cplan.md)",
    );
    expect(decodeReference("[plan](file:src%2Fa%20folder%2Fplan.md)")?.target).toBe(
      "src/a folder/plan.md",
    );
  });

  test("labels are single-line snapshots without changing targets", () => {
    expect(
      decodeReference(encodeReference({ kind: "task", target: "one", label: "  Plan\n next\t" })),
    ).toEqual({ kind: "task", target: "one", label: "Plan next" });
  });

  test("an unlabeled reference displays its target", () => {
    expect(
      decodeReference(encodeReference({ kind: "file", target: "src/plan.md", label: " " })),
    ).toEqual({ kind: "file", target: "src/plan.md", label: "src/plan.md" });
  });

  test("splits mixed kinds in source order with UTF-16 offsets, retaining duplicate labels", () => {
    const found: Reference[] = [
      { kind: "session", target: "copilot:one", label: "Same" },
      { kind: "file", target: "src/two.ts", label: "Same" },
      { kind: "issue", target: "repo:42", label: "Same" },
    ];
    const sources = found.map(encodeReference);
    const content = `\u{1f9e9} Compare ${sources.join("\nwith ")}.`;
    const at = (index: number) => ({
      ...found[index]!,
      from: content.indexOf(sources[index]!),
      to: content.indexOf(sources[index]!) + sources[index]!.length,
    });
    expect(splitReferences(content)).toEqual([
      "\u{1f9e9} Compare ",
      at(0),
      "\nwith ",
      at(1),
      "\nwith ",
      at(2),
      ".",
    ]);
  });

  test("references a host rejects stay in the surrounding text", () => {
    const task = encodeReference({ kind: "task", target: "42", label: "Plan" });
    const file = encodeReference({ kind: "file", target: "plan.md", label: "plan.md" });
    const isFile = (reference: Reference): reference is Reference & { kind: "file" } =>
      reference.kind === "file";
    const content = `See ${task} and ${file}.`;
    const from = content.indexOf(file);
    expect(splitReferences(content, isFile)).toEqual([
      `See ${task} and `,
      { kind: "file", target: "plan.md", label: "plan.md", from, to: from + file.length },
      ".",
    ]);
  });

  test("source scanning leaves interpretation of Markdown and kinds to the host", () => {
    const source = encodeReference({ kind: "task", target: "42", label: "Plan" });
    for (const content of [`**${source}**`, `\`${source}\``, `\`\`\`\n${source}\n\`\`\``])
      expect(splitReferences(content)[1]).toMatchObject({ kind: "task", target: "42" });
    expect(splitReferences("@agent #tag /skill https://example.com")).toEqual([
      "@agent #tag /skill https://example.com",
    ]);
    expect(decodeReference("[Website](https://example.com)")).toEqual({
      kind: "https",
      target: "//example.com",
      label: "Website",
    });
  });

  test("malformed sources stay text", () => {
    for (const source of [
      "[Title](task:)",
      "[Title](task:%ZZ)",
      "[Title](task:%00)",
      "[Title](task:id",
      "[Title](task:a b)",
      "[Title](bad kind:id)",
      "[Title](1kind:id)",
    ]) {
      expect(decodeReference(source)).toBeUndefined();
      expect(splitReferences(source)).toEqual([source]);
    }
  });

  test("encoding rejects values that cannot round-trip", () => {
    for (const reference of [
      { kind: "bad kind", target: "one", label: "Name" },
      { kind: "task", target: "", label: "Name" },
      { kind: "task", target: "\0", label: "Name" },
    ])
      expect(() => encodeReference(reference)).toThrow();
  });
});
