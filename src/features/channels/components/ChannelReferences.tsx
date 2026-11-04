import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { Components } from "streamdown";
import { parseChannelUri } from "@channels/model/references";
import { decodeReference } from "@/shared/references";

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hName: string; hProperties: Record<string, string> };
};

const TAG = "channel-reference";

function referenceNode(uri: string, label: string): MarkdownNode {
  return {
    type: "text",
    value: label,
    data: { hName: TAG, hProperties: { uri } },
  };
}

/** Bare URIs and Markdown references share one destination; code and link labels stay literal. */
export function remarkChannelReferences() {
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
          const decodedUri =
            reference?.kind === "channel" ? `channel:${reference.target}` : undefined;
          const uri = decodedUri && parseChannelUri(decodedUri) ? decodedUri : child.url;
          if (parseChannelUri(uri)) {
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
        for (const match of child.value.matchAll(/(?<![\w:])channel:[^\s<>[\]`"()]+/g)) {
          const uri = match[0].replace(/[.,;!?]+$/, "");
          if (!parseChannelUri(uri)) continue;
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

function ChannelReferenceLink({
  uri,
  children,
}: {
  [key: string]: unknown;
  uri?: string;
  children?: ReactNode;
}) {
  const target = uri && parseChannelUri(uri);
  if (!target) return <span>{children}</span>;
  return (
    <Link
      to="/"
      search={{ channels: [target.channelId] }}
      hash={encodeURIComponent(uri!)}
      title={uri}
      className="wrap-anywhere font-medium text-primary underline"
    >
      {children}
    </Link>
  );
}

export const channelReferenceTags = { [TAG]: ["uri"] };
export const channelReferenceComponents = { [TAG]: ChannelReferenceLink } satisfies Components;
