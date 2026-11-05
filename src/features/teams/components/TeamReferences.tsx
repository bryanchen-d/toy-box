import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Components } from "streamdown";
import { parseTeamUri } from "@teams/model/references";
import { decodeReference } from "@/shared/references";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName: string; hProperties: Record<string, string> };
};

const TAG = "team-reference";

function referenceNode(uri: string, label: string): MarkdownNode {
  return {
    type: "text",
    value: label,
    data: { hName: TAG, hProperties: { uri } },
  };
}

/** Bare URIs and Markdown references share one destination; code and link labels stay literal. */
export function remarkTeamReferences() {
  return (root: MarkdownNode, file: { value: unknown }) => {
    function visit(node: MarkdownNode) {
      if (!node.children || ["code", "inlineCode", "link", "linkReference"].includes(node.type))
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "link" && child.url) {
          const from = child.position?.start.offset;
          const to = child.position?.end.offset;
          const reference =
            typeof file.value === "string" && from !== undefined && to !== undefined
              ? decodeReference(file.value.slice(from, to))
              : undefined;
          const decodedUri = reference?.kind === "team" ? `team:${reference.target}` : undefined;
          const uri = decodedUri && parseTeamUri(decodedUri) ? decodedUri : child.url;
          if (parseTeamUri(uri)) {
            const label =
              reference?.label || child.children?.map((part) => part.value ?? "").join("") || uri;
            return [referenceNode(uri, label)];
          }
        }
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const parts: MarkdownNode[] = [];
        let offset = 0;
        for (const match of child.value.matchAll(/(?<![\w:])team:[^\s<>[\]`"()]+/g)) {
          const uri = match[0].replace(/[.,;!?]+$/, "");
          if (!parseTeamUri(uri)) continue;
          if (match.index > offset)
            parts.push({ type: "text", value: child.value.slice(offset, match.index) });
          parts.push(referenceNode(uri, uri));
          offset = match.index + uri.length;
        }
        if (!offset) return [child];
        if (offset < child.value.length)
          parts.push({ type: "text", value: child.value.slice(offset) });
        return parts;
      });
    }
    visit(root);
  };
}

function TeamReferenceLink({
  uri,
  children,
}: {
  [key: string]: unknown;
  uri?: string;
  children?: ReactNode;
}) {
  const target = uri && parseTeamUri(uri);
  if (!target) return <span>{children}</span>;
  return (
    <Link
      to="/"
      search={{ teams: [target.teamId] }}
      hash={encodeURIComponent(uri!)}
      title={uri}
      className="wrap-anywhere font-medium text-primary underline"
    >
      {children}
    </Link>
  );
}

export const teamReferenceTags = { [TAG]: ["uri"] };
export const teamReferenceComponents = { [TAG]: TeamReferenceLink } satisfies Components;
