import type { ComponentProps, ReactNode } from "react";
import { code } from "@streamdown/code";
import { ExternalLink } from "lucide-react";
import { Lexer, type Token } from "marked";
import { parseEntities } from "parse-entities";
import {
  defaultRemarkPlugins,
  Streamdown,
  type Components,
  type ExtraProps,
  type StreamdownProps,
} from "streamdown";
import { cn } from "@/shared/utils";

/** Highlights fenced code. Streamdown shares plugins through context, so one module-level
 *  object keeps streamed updates from re-rendering every code element in unchanged blocks. */
export const codePlugins = { code } satisfies StreamdownProps["plugins"];

const markdownComponents = { a: MarkdownLink } satisfies Components;

type MarkdownProps = StreamdownProps & {
  /** Preserve authored newlines inside text blocks, not whitespace between Markdown blocks. */
  preserveLineBreaks?: boolean;
};

type InlineMarkdownProps = {
  children: string;
  allowLinks?: boolean;
};

export function Markdown({
  className,
  mode = "static",
  preserveLineBreaks = false,
  remarkPlugins,
  components,
  ...streamdownProps
}: MarkdownProps) {
  return (
    <Streamdown
      {...streamdownProps}
      mode={mode}
      components={components ? { ...markdownComponents, ...components } : markdownComponents}
      remarkPlugins={
        preserveLineBreaks
          ? [...(remarkPlugins ?? Object.values(defaultRemarkPlugins)), remarkPreserveLineBreaks]
          : remarkPlugins
      }
      className={cn("space-y-3 [&_blockquote]:space-y-2", className)}
    />
  );
}

export function MarkdownLink({
  node: _node,
  href,
  children,
  className,
  ...props
}: ComponentProps<"a"> & ExtraProps) {
  const destination = href && safeHref(href);
  if (!destination) return <span>{children}</span>;
  const external = /^(?:https?:|\/\/)/i.test(destination);
  return (
    <a
      {...props}
      href={destination}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      data-streamdown="link"
      className={cn("wrap-anywhere font-medium text-primary underline", className)}
    >
      {children}
      {external && <ExternalLink aria-hidden className="ml-0.5 inline size-3 align-text-top" />}
    </a>
  );
}

type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[] };

function remarkPreserveLineBreaks() {
  return (root: MarkdownNode) => {
    const visit = (node: MarkdownNode): void => {
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== "text" || !child.value?.includes("\n")) {
          visit(child);
          return child;
        }
        return child.value
          .split("\n")
          .flatMap((value, index) => [
            ...(index ? [{ type: "break" }] : []),
            ...(value ? [{ type: "text", value }] : []),
          ]);
      });
    };
    visit(root);
  };
}

export function InlineMarkdown({ children, allowLinks = true }: InlineMarkdownProps) {
  return <>{renderInline(Lexer.lexInline(children), allowLinks)}</>;
}

function renderInline(tokens: Token[], allowLinks: boolean): ReactNode[] {
  let offset = 0;
  return tokens.map((token) => {
    const key = offset;
    offset += token.raw.length;
    switch (token.type) {
      case "text":
      case "escape":
      case "html":
      case "image":
        return parseEntities(token.text);
      case "strong":
        return (
          <strong key={key} className="font-semibold">
            {renderInline(token.tokens ?? [], allowLinks)}
          </strong>
        );
      case "em":
        return <em key={key}>{renderInline(token.tokens ?? [], allowLinks)}</em>;
      case "del":
        return <del key={key}>{renderInline(token.tokens ?? [], allowLinks)}</del>;
      case "codespan":
        return (
          <code key={key} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[1em]">
            {token.text}
          </code>
        );
      case "br":
        return <br key={key} />;
      case "link": {
        const label = renderInline(token.tokens ?? [], allowLinks);
        const href = safeHref(parseEntities(token.href));
        return allowLinks && href !== undefined ? (
          <MarkdownLink
            key={key}
            href={href}
            title={token.title ? parseEntities(token.title) : undefined}
          >
            {label}
          </MarkdownLink>
        ) : (
          label
        );
      }
      default:
        return parseEntities(token.raw);
    }
  });
}

function safeHref(raw: string): string | undefined {
  const href = raw.trim();
  try {
    const protocol = new URL(href, "https://localhost").protocol;
    if (["http:", "https:", "mailto:", "tel:"].includes(protocol)) return href;
  } catch {
    return undefined;
  }
}
