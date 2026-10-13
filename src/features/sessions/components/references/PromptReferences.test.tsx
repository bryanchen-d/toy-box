import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { encodeReference, type Reference } from "@/shared/references";
import { Markdown } from "@/shared/ui/markdown";
import { PromptReferenceMarkdown, PromptReferenceText, promptReferences } from "./PromptReferences";

/** Counts rendered pills of one kind. */
const pills = (markup: string, kind: string) =>
  markup.match(new RegExp(`class="prompt-reference ${kind}-reference`, "g"))?.length ?? 0;

const session: Reference = { kind: "session", target: "codex:native-id", label: "Planning" };
const file: Reference = { kind: "file", target: "src/a folder/plan.md", label: "plan.md" };

describe("prompt reference presentation", () => {
  test("sent messages show references as pills, even within formatting, never as links", () => {
    const markup = renderToStaticMarkup(
      <PromptReferenceMarkdown
        content={`Read **${encodeReference(session)}** and ${encodeReference(file)}.`}
      />,
    );
    expect([pills(markup, "session"), pills(markup, "file")]).toEqual([1, 1]);
    expect(markup).toContain('data-streamdown="strong"');
    expect(markup).not.toMatch(/href="(session|file):/);
    expect(markup).not.toContain("[blocked]");
  });

  test("a pill's title names its full target, the same in the composer and in messages", () => {
    for (const reference of [session, file]) {
      const { title } = promptReferences(reference)!;
      expect(title).toContain(reference.target);
      const markup = renderToStaticMarkup(
        <PromptReferenceMarkdown content={encodeReference(reference)} />,
      );
      expect(markup).toContain(`title="${title}"`);
    }
  });

  test("code keeps reference sources literal, and other links keep Markdown sanitization", () => {
    const source = encodeReference(session);
    const markup = renderToStaticMarkup(
      <PromptReferenceMarkdown
        content={`\`${source}\`\n\n${source}\n\n[unsafe](javascript:alert(1))`}
      />,
    );
    expect(pills(markup, "session")).toBe(1);
    expect(markup).toContain("session:codex:native-id");
    expect(markup).not.toContain('href="javascript:');
  });

  test("queue summaries show references as pills and leave the rest literal", () => {
    const markup = renderToStaticMarkup(
      <PromptReferenceText
        content={`**Read** ${encodeReference(session)} and ${encodeReference(file)}`}
      />,
    );
    expect([pills(markup, "session"), pills(markup, "file")]).toEqual([1, 1]);
    expect(markup).toContain("**Read**");
    expect(markup).not.toContain("file:src");
  });

  test("Sessions recognizes only its reference kinds; others stay as written", () => {
    const task = { kind: "task", target: "42", label: "Next task" };
    const other = `${encodeReference(task)} [Website](https://example.com)`;
    expect(promptReferences(task)).toBeUndefined();
    expect(renderToStaticMarkup(<PromptReferenceText content={other} />)).toBe(
      renderToStaticMarkup(<>{other}</>),
    );
    expect(renderToStaticMarkup(<PromptReferenceMarkdown content={other} />)).toBe(
      renderToStaticMarkup(<Markdown preserveLineBreaks>{other}</Markdown>),
    );
  });
});
