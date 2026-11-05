import { ListChecks } from "lucide-react";
import { teamTasksDiff, type Team, type TeamArtifact } from "@teams/model";
import { Badge } from "@/shared/ui/badge";
import { Checklist } from "@/shared/ui/checklist";
import { useTeamPane } from "./TeamPaneContext";
import { TeamPanelHeader } from "./TeamPanelHeader";
import { teamTaskItems, TaskDiff } from "./teamTaskItems";

/** The lead's public task list, with each task's owner, artifact, and reported diff. */
export function TeamTasks({ team, artifacts }: { team: Team; artifacts: TeamArtifact[] }) {
  const { agents, openArtifact } = useTeamPane();
  const completedCount = team.tasks.filter(({ status }) => status === "done").length;
  const diff = teamTasksDiff(team.tasks);

  return (
    <section aria-label="Task list" className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <TeamPanelHeader icon={ListChecks} title="Task list">
        <Badge variant="count">
          {completedCount}/{team.tasks.length}
        </Badge>
        {diff && <TaskDiff diff={diff} />}
      </TeamPanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {team.tasks.length > 0 ? (
          <Checklist
            items={teamTaskItems({
              tasks: team.tasks,
              owners: agents,
              artifacts,
              onArtifactOpen: (artifact) => openArtifact(artifact.file),
            })}
            className="text-sm"
          />
        ) : (
          <p className="text-sm text-muted-foreground italic">No tasks yet.</p>
        )}
      </div>
    </section>
  );
}
