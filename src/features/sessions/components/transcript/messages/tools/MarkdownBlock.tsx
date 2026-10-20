import { codePlugins, Markdown } from "@/shared/ui/markdown";

type MarkdownBlockProps = {
  title?: string;
  maxHeight?: string;
  children?: string;
};

export function MarkdownBlock({ title, maxHeight = "max-h-48", children }: MarkdownBlockProps) {
  if (!children) return null;

  return (
    <div>
      {title && <div className="text-xs text-muted-foreground mb-1">{title}</div>}
      <div className={`bg-secondary-background text-xs p-2 rounded overflow-x-auto ${maxHeight}`}>
        <Markdown plugins={codePlugins}>{children}</Markdown>
      </div>
    </div>
  );
}
