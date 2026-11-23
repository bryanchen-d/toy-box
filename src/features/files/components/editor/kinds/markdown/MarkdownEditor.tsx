import {
  Documint,
  type CommentChange,
  type DocumentPresence,
  type DocumentUser,
  type DocumintStorage,
  type EditorTheme,
} from "@lostintangent/documint";
import { useMutation } from "@tanstack/react-query";
import type { JSONType } from "zod";
import type { EditorProps } from "../index";
import { useColorScheme } from "@/shared/hooks/useColorScheme";
import { useWorkspaceSelector } from "@workspace/hooks/state";
import { useWorkspaceSurface } from "@workspace/hooks/layout/surface";
import { createEditorPaneId } from "@workspace/model/panes";
import type { WorkspaceFile } from "@files/model";
import { resolveFileLink } from "@files/server/functions";
import { buildArtifactCommentPrompt } from "./comments";

const ASSISTANT_USER = {
  id: "assistant",
  username: "assistant",
  fullName: "Assistant",
} satisfies DocumentUser;
const DOCUMINT_USERS = [ASSISTANT_USER];

/** Rich Markdown editing with live external diffs and inline Assistant responses. */
export function MarkdownEditor({ mode, file, pendingWorkers, spawnWorker }: EditorProps) {
  const theme = useDocumintTheme();
  const storage = useLinkedFileStorage(file.source);
  const presence: DocumentPresence[] = pendingWorkers.flatMap((worker) => {
    const threadId = artifactCommentThreadId(worker.metadata);
    return threadId
      ? [
          {
            userId: ASSISTANT_USER.id,
            cursor: { threadId },
            color: "#8b5cf6",
            status: "Assistant is working…",
          },
        ]
      : [];
  });

  async function handleCommentChanged(change: CommentChange) {
    if (change.kind !== "added" || !spawnWorker) {
      await file.flush({ notifyAgent: false });
      return;
    }

    await spawnWorker({
      name: "Respond to comment",
      prompt: buildArtifactCommentPrompt(change.thread, new Date()),
      metadata: { threadId: change.threadId },
    });
  }

  return (
    <Documint
      content={file.content ?? ""}
      onCommentChanged={handleCommentChanged}
      onContentChanged={file.save}
      readOnly={mode === "read"}
      users={DOCUMINT_USERS}
      presence={presence}
      showDiffs={mode !== "edit"}
      storage={storage}
      theme={theme}
    />
  );
}

/**
 * Documint opens web links itself and hands every other Ctrl/Cmd-clicked link here, where the
 * server resolves it against this file so a linked artifact opens in its own editor pane. Images
 * and pastes still have no storage.
 */
function useLinkedFileStorage(source: WorkspaceFile): DocumintStorage {
  const { revealFile, focusedPaneAtom } = useWorkspaceSurface();
  const { mutate: openLink } = useMutation({
    mutationFn: (href: string) => resolveFileLink({ data: { file: source, href } }),
    onSuccess: (target) => {
      if (!target) return;
      if (revealFile) revealFile(target);
      else focusedPaneAtom.set(createEditorPaneId(target));
    },
  });

  return {
    readFile: async () => null,
    writeFile: () => Promise.reject(new Error("Markdown files do not store pasted files.")),
    openFile: openLink,
  };
}

function artifactCommentThreadId(metadata: JSONType | undefined): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  return typeof metadata.threadId === "string" ? metadata.threadId : undefined;
}

function useDocumintTheme(): EditorTheme {
  "use no memo";

  // Resolved CSS colors are external state and must not be cached by React Compiler.
  useColorScheme();
  const accentColor = useWorkspaceSelector((workspace) => workspace.settings.accentColor);

  return {
    accent: accentColor,
    background: readThemeColor("--background"),
    codeBackground: readThemeColor("--muted"),
    fontSize: 14,
    muted: readThemeColor("--muted-foreground"),
    text: readThemeColor("--foreground"),
  };
}

function readThemeColor(variableName: `--${string}`): string {
  if (typeof document === "undefined") return `var(${variableName})`;

  const value = getComputedStyle(document.documentElement).getPropertyValue(variableName).trim();
  if (!value) throw new Error(`Missing Agent Teams theme color: ${variableName}`);
  return value;
}
