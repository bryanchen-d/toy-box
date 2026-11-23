import { Loader2 } from "lucide-react";
import type { PaneVariant } from "@workspace/components/panes/shell/WorkspacePaneView";
import {
  PANE_OVERLAY_BUTTON_CLASS,
  PANE_OVERLAY_ICON_CLASS,
} from "@workspace/components/panes/shell/paneControls";
import { cn } from "@/shared/utils";
import type { WorkspaceFile, WorkspaceFileMode } from "../../../model";
import { CopyFileUri } from "../../CopyFileUri";
import { EditorModeMenu } from "./EditorModeMenu";

/** Saving state, the file's URI, and mode controls shared by grid and pager hosts. */
export function EditorActions({
  file,
  editable,
  mode,
  isSaving,
  onModeChange,
  variant,
}: {
  file: WorkspaceFile;
  editable: boolean;
  mode: WorkspaceFileMode;
  isSaving: boolean;
  onModeChange: (mode: WorkspaceFileMode) => void;
  variant: PaneVariant;
}) {
  const isNormal = variant === "normal";
  return (
    <>
      {isSaving && (
        <div
          className="flex items-center justify-center p-1.5"
          role="status"
          aria-label="Saving file"
          title="Saving file"
        >
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      )}
      <CopyFileUri
        file={file}
        variant="button"
        label="Copy file URI"
        className={isNormal ? cn(PANE_OVERLAY_BUTTON_CLASS, "size-auto") : undefined}
        iconClassName={isNormal ? cn(PANE_OVERLAY_ICON_CLASS, "size-4") : undefined}
      />
      {editable && (
        <EditorModeMenu
          mode={mode}
          onModeChange={onModeChange}
          showLabel={!isNormal}
          className={isNormal ? PANE_OVERLAY_BUTTON_CLASS : undefined}
          iconClassName={isNormal ? PANE_OVERLAY_ICON_CLASS : undefined}
        />
      )}
    </>
  );
}
