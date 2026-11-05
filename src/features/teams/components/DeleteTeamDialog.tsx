import type { Team } from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { DestructiveConfirmationDialog } from "@/shared/sidebar/DestructiveConfirmationDialog";

export function DeleteTeamDialog({
  team,
  onOpenChange,
}: {
  team: Team;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DestructiveConfirmationDialog
      title={`Delete #${team.name}?`}
      description="This removes the shared transcript and artifact index, and deletes the lead and each member's private team session. Files in the working directory are not deleted."
      mutation={teamMutations.delete(team.id)}
      onOpenChange={onOpenChange}
    />
  );
}
