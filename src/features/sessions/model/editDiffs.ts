import type { Message, ToolCall } from "./index";
import { computeFileDiffStats, getToolCallFileDiffs } from "./fileDiffs";
import type { DiffStats } from "@/shared/diffStats";
import { toRelativePath } from "@files/model/paths";

export interface FileDiffSummary {
  path: string;
  displayPath: string;
  diff: DiffStats;
}

export interface SessionDiffs {
  total: DiffStats;
  byFile: FileDiffSummary[];
  byToolCallId: Map<string, DiffStats>;
}

type ToolDiff = {
  cwd?: string;
} & ReturnType<typeof computeFileDiffStats>;

function getFileDiffToolCalls(messages: Message[]): ToolCall[] {
  const toolCalls: ToolCall[] = [];

  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls) continue;
    for (const toolCall of message.toolCalls) {
      if (toolCall.name === "edit" || toolCall.name === "patch") toolCalls.push(toolCall);
    }
  }

  return toolCalls;
}

function computeToolDiff(
  toolCall: ToolCall,
  cache: WeakMap<ToolCall, ToolDiff>,
  cwd?: string,
): ToolDiff | undefined {
  if (toolCall.result?.success !== true) {
    cache.delete(toolCall);
    return undefined;
  }

  const cached = cache.get(toolCall);
  if (cached && cached.cwd === cwd) return cached;

  const fileDiffs = getToolCallFileDiffs(toolCall, cwd);
  if (!fileDiffs) return undefined;

  const diff = computeFileDiffStats(fileDiffs);
  const next = { cwd, total: diff.total, byFile: diff.byFile };
  cache.set(toolCall, next);
  return next;
}

function summarizeSessionDiffs(
  toolCalls: ToolCall[],
  cwd: string | undefined,
  toolDiffs: WeakMap<ToolCall, ToolDiff>,
): SessionDiffs {
  const byToolCallId = new Map<string, DiffStats>();
  const files = new Map<string, FileDiffSummary>();
  const total = { added: 0, removed: 0 };

  for (const toolCall of toolCalls) {
    const toolDiff = computeToolDiff(toolCall, toolDiffs, cwd);
    if (!toolDiff) continue;

    byToolCallId.set(toolCall.id, { ...toolDiff.total });
    total.added += toolDiff.total.added;
    total.removed += toolDiff.total.removed;

    for (const file of toolDiff.byFile) {
      const existing = files.get(file.path);
      if (existing) {
        existing.diff.added += file.diff.added;
        existing.diff.removed += file.diff.removed;
      } else {
        files.set(file.path, {
          path: file.path,
          displayPath: toRelativePath(file.path, cwd),
          diff: { ...file.diff },
        });
      }
    }
  }

  return {
    total,
    byFile: Array.from(files.values()),
    byToolCallId,
  };
}

/** Computes diff totals for successful edit and patch tool calls. */
export function computeSessionDiffs(messages: Message[], cwd?: string): SessionDiffs {
  return summarizeSessionDiffs(getFileDiffToolCalls(messages), cwd, new WeakMap());
}

/** Reuse immutable tool parses without extending the lifetime of canonical tools. */
export function createSessionDiffsProjector() {
  const cache = new WeakMap<ToolCall, ToolDiff>();
  return (messages: Message[], cwd?: string): SessionDiffs =>
    summarizeSessionDiffs(getFileDiffToolCalls(messages), cwd, cache);
}
