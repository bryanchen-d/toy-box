import { useMutation } from "@tanstack/react-query";
import { FolderOpen, Pause, Pencil, Play, Trash2 } from "lucide-react";
import type { Channel } from "@channels/model";
import { channelMutations } from "@channels/mutations";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/shared/ui/dropdown-menu";

/** A Channel's actions, shared by every menu that offers them. */
export function ChannelMenuItems({
  channel,
  onEdit,
  onBrowse,
  onDelete,
}: {
  channel: Channel;
  onEdit: () => void;
  /** Opens the file browser at the working directory, when the Channel has one. */
  onBrowse?: () => void;
  onDelete: () => void;
}) {
  const { mutate, isPending, error, variables } = useMutation(channelMutations.edit());
  return (
    <>
      <DropdownMenuItem
        closeOnClick={false}
        disabled={isPending}
        onClick={() => mutate({ channelId: channel.id, paused: !channel.paused })}
      >
        {channel.paused ? <Play /> : <Pause />}
        {isPending
          ? variables?.paused
            ? "Pausing..."
            : "Resuming..."
          : channel.paused
            ? "Resume channel"
            : "Pause channel"}
      </DropdownMenuItem>
      {error && (
        <p role="alert" className="max-w-64 px-2 py-1 text-xs text-destructive">
          {error.message}
        </p>
      )}
      <DropdownMenuItem onClick={onEdit}>
        <Pencil /> Edit channel
      </DropdownMenuItem>
      {onBrowse && (
        <DropdownMenuItem onClick={onBrowse}>
          <FolderOpen /> Browse files
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 /> Delete channel
      </DropdownMenuItem>
    </>
  );
}
