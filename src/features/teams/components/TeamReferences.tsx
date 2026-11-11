import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquareReply, UserRound, UsersRound } from "lucide-react";
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

function referenceNode(uri: string, label?: string): MarkdownNode {
  const target = parseTeamUri(uri);
  const fallback =
    target?.type === "message"
      ? `Message #${target.sequence}`
      : target?.type === "members"
        ? "Team members"
        : target?.type === "agent"
          ? `Agent ${target.agentId}`
          : target
            ? `Team ${target.teamId}`
            : uri;
  return {
    type: "text",
    value: label || fallback,
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
          parts.push(referenceNode(uri));
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
  const Icon =
    target.type === "message"
      ? MessageSquareReply
      : target.type === "agent"
        ? UserRound
        : UsersRound;
  return (
    <Link
      to="/"
      search={{ teams: [target.teamId] }}
      hash={encodeURIComponent(uri!)}
      title={uri}
      data-streamdown="link"
      className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 align-baseline font-medium text-primary ring-1 ring-inset ring-primary/20 hover:bg-primary/20"
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 wrap-anywhere">{children}</span>
    </Link>
  );
}

export const teamReferenceTags = { [TAG]: ["uri"] };
export const teamReferenceComponents = { [TAG]: TeamReferenceLink } satisfies Components;
