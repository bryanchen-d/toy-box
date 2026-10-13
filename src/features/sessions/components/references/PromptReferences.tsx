import type { ComponentType, ReactNode } from "react";
import { defaultRemarkPlugins, type Components } from "streamdown";
import { Markdown } from "@/shared/ui/markdown";
import type { ComposerReferences } from "@/shared/composers/input/ComposerInput";
import { decodeReference, splitReferences } from "@/shared/references";
import { cn } from "@/shared/utils";
import { isPromptReference, type PromptReference } from "../../model/references";
import "./PromptReferences.css";

/** Each kind's presentation. Its icon is the stylesheet's mask, which its pills also show. */
export const promptReferenceKinds = {
  session: {
    title: ({ label, target }) => `Session: ${label}\n${target}`,
    Icon: referenceIcon("session"),
  },
  file: { title: ({ target }) => `File: ${target}`, Icon: referenceIcon("file") },
} satisfies Record<
  PromptReference["kind"],
  {
    title: (reference: PromptReference) => string;
    Icon: ComponentType<{ className?: string }>;
  }
>;

const referenceTitle = (reference: PromptReference) =>
  promptReferenceKinds[reference.kind].title(reference);

/** Pills in a sent or queued message add a thin border and a stronger tint than the draft's. */
function pillClassName(kind: string, surface: "draft" | "message"): string {
  return cn(
    `prompt-reference ${kind}-reference`,
    surface === "draft" ? "bg-accent/20" : "bg-accent/25 ring-1 ring-inset ring-accent/40",
  );
}

function referenceIcon(kind: PromptReference["kind"]) {
  return function ReferenceIcon({ className }: { className?: string }) {
    return (
      <span aria-hidden className={cn("prompt-reference-icon", `${kind}-reference`, className)} />
    );
  };
}

/** The composer shows Sessions' references as pills; other kinds stay text. */
export const promptReferences: ComposerReferences = (reference) =>
  isPromptReference(reference)
    ? { title: referenceTitle(reference), className: pillClassName(reference.kind, "draft") }
    : undefined;

function ReferencePill({
  children,
  kind,
  title,
}: {
  [key: string]: unknown;
  children?: ReactNode;
  kind?: string;
  title?: string;
}) {
  return (
    <span title={title} aria-label={title} className={pillClassName(kind ?? "", "message")}>
      {children}
    </span>
  );
}

/** Queue summaries decorate references without interpreting the rest of the draft. */
export function PromptReferenceText({ content }: { content: string }) {
  return splitReferences(content, isPromptReference).map((segment) =>
    typeof segment === "string" ? (
      segment
    ) : (
      <ReferencePill key={segment.from} kind={segment.kind} title={referenceTitle(segment)}>
        {segment.label}
      </ReferencePill>
    ),
  );
}

type MarkdownNode = {
  type: string;
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: MarkdownNode[];
  data?: { hName: string; hProperties: Record<string, string> };
};

const REFERENCE_TAG = "prompt-reference";

/** Recognizes only canonical sources, so links are decoded by the same codec as the composer. */
function remarkPromptReferences() {
  return (root: MarkdownNode, file: { value: unknown }) => {
    if (typeof file.value !== "string") return;
    const content = file.value;
    function visit(node: MarkdownNode) {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        const from = child.position?.start.offset;
        const to = child.position?.end.offset;
        const reference =
          child.type === "link" && from !== undefined && to !== undefined
            ? decodeReference(content.slice(from, to))
            : undefined;
        if (reference && isPromptReference(reference)) {
          return {
            type: "text",
            value: reference.label,
            data: {
              hName: REFERENCE_TAG,
              hProperties: { kind: reference.kind, title: referenceTitle(reference) },
            },
          };
        }
        visit(child);
        return child;
      });
    }
    visit(root);
  };
}

const plugins = [...Object.values(defaultRemarkPlugins), remarkPromptReferences];
const allowedTags = { [REFERENCE_TAG]: ["kind", "title"] };
const components = { [REFERENCE_TAG]: ReferencePill } satisfies Components;

export function PromptReferenceMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      preserveLineBreaks
      remarkPlugins={plugins}
      allowedTags={allowedTags}
      components={components}
    >
      {content}
    </Markdown>
  );
}
