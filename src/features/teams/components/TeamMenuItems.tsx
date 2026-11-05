import { useMutation } from "@tanstack/react-query";
import { FolderOpen, Pause, Pencil, Play, Trash2 } from "lucide-react";
import type { Team } from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/shared/ui/dropdown-menu";
import { CopyTeamUri } from "./CopyTeamUri";

/** A Team's actions, shared by every menu that offers them. */
export function TeamMenuItems({
  team,
  onEdit,
  onBrowse,
  onDelete,
}: {
  team: Team;
  onEdit: () => void;
  /** Opens the file browser at the working directory, when the Team has one. */
  onBrowse?: () => void;
  onDelete: () => void;
}) {
  const { mutate, isPending, error, variables } = useMutation(teamMutations.edit());
  return (
    <>
      <CopyTeamUri target={{ type: "team", teamId: team.id }} label="Copy team URI" />
      <DropdownMenuItem
        closeOnClick={false}
        disabled={isPending}
        onClick={() => mutate({ teamId: team.id, paused: !team.paused })}
      >
        {team.paused ? <Play /> : <Pause />}
        {isPending
          ? variables?.paused
            ? "Pausing..."
            : "Resuming..."
          : team.paused
            ? "Resume team"
            : "Pause team"}
      </DropdownMenuItem>
      {error && (
        <p role="alert" className="max-w-64 px-2 py-1 text-xs text-destructive">
          {error.message}
        </p>
      )}
      <DropdownMenuItem onClick={onEdit}>
        <Pencil /> Edit team
      </DropdownMenuItem>
      {onBrowse && (
        <DropdownMenuItem onClick={onBrowse}>
          <FolderOpen /> Browse files
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <Trash2 /> Delete team
      </DropdownMenuItem>
    </>
  );
}
