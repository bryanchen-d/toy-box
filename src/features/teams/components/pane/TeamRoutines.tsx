import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Clock3, Play, Trash2 } from "lucide-react";
import type { Team, TeamRoutine } from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { Badge } from "@/shared/ui/badge";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/shared/ui/dropdown-menu";
import { RelativeTime } from "@/shared/ui/relative-time";
import { nextCronOccurrence } from "@/shared/cron";
import { RowMenu } from "./overview/RowMenu";
import { TeamPanelHeader } from "./TeamPanelHeader";

/** The lead's scheduled prompts, each of which the user can run now or delete. */
export function TeamRoutines({
  team,
  routines,
  onClose,
}: {
  team: Team;
  routines: TeamRoutine[];
  onClose: () => void;
}) {
  return (
    <section aria-label="Routines" className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <TeamPanelHeader icon={Clock3} title="Routines" closeLabel="Close routines" onClose={onClose}>
        <Badge variant="count">{routines.length}</Badge>
      </TeamPanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {routines.length > 0 ? (
          <div role="list" aria-label={`Routines in #${team.name}`} className="space-y-2">
            {routines.map((routine) => (
              <RoutineItem
                key={routine.id}
                teamId={team.id}
                paused={team.paused}
                routine={routine}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground italic">No routines scheduled yet.</p>
        )}
      </div>
    </section>
  );
}

/** A routine's title and next run, expanding to its prompt. Only the lead adds or changes one;
 *  you can run or delete it. */
function RoutineItem({
  teamId,
  paused,
  routine,
}: {
  teamId: string;
  paused: boolean;
  routine: TeamRoutine;
}) {
  const { mutate: runRoutine, error: runError } = useMutation(teamMutations.runRoutine(teamId));
  const { mutate: deleteRoutine } = useMutation(teamMutations.deleteRoutine(teamId));
  const [now] = useState(() => new Date());

  return (
    <div role="listitem" className="flex items-start gap-2 text-sm">
      <details className="group min-w-0 flex-1">
        <summary className="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
          />
          <span className="flex min-w-0 flex-col items-start gap-1">
            <span className="text-foreground/90">{routine.title}</span>
            <Badge variant="metadata" title={routine.schedule}>
              <Clock3 className="h-3 w-3 shrink-0" />
              {paused ? (
                "Paused"
              ) : (
                <RelativeTime date={nextCronOccurrence(routine.schedule, now)} />
              )}
            </Badge>
          </span>
        </summary>
        <p className="mt-1.5 ml-5.5 whitespace-pre-wrap text-xs text-muted-foreground">
          {routine.prompt}
        </p>
        {runError && (
          <p role="alert" className="text-xs text-destructive">
            {runError.message}
          </p>
        )}
      </details>
      <RowMenu name={routine.title}>
        <DropdownMenuItem disabled={paused} onClick={() => runRoutine(routine.id)}>
          <Play /> Run routine
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => deleteRoutine(routine.id)}>
          <Trash2 /> Delete routine
        </DropdownMenuItem>
      </RowMenu>
    </div>
  );
}
