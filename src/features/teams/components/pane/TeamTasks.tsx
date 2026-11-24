import { useMutation } from "@tanstack/react-query";
import { ListChecks, ListTodo, LoaderCircle } from "lucide-react";
import {
  isTeamTaskOpen,
  teamTasksDiff,
  teamTaskTree,
  type TeamArtifact,
  type TeamTask,
} from "@teams/model";
import { findTeamTaskMessage } from "@teams/server/functions";
import { Badge } from "@/shared/ui/badge";
import { Checklist, isChecklistItemFinished, type ChecklistFilter } from "@/shared/ui/checklist";
import { useTeamPane } from "./TeamPaneContext";
import { TeamPanelHeader } from "./TeamPanelHeader";
import { teamTaskItems, TaskDiff } from "./teamTaskItems";
import { ViewMenu, type ViewOption } from "./ViewMenu";

/** Which tasks the panel shows: open ones, only those in progress, or all of them. */
export type TaskView = "open" | "in_progress" | "all";

const VIEWS: (ViewOption<TaskView> & { show?: ChecklistFilter; empty?: string })[] = [
  {
    value: "open",
    label: "Open tasks",
    Icon: ListTodo,
    show: (item) => !isChecklistItemFinished(item),
    empty: "No open tasks.",
  },
  {
    value: "in_progress",
    label: "Tasks in progress",
    Icon: LoaderCircle,
    show: ({ status }) => status === "in_progress",
    empty: "Nothing in progress.",
  },
  { value: "all", label: "All tasks", Icon: ListChecks },
];

/**
 * The team's task list, with each task's assignee, artifact, and reported diff, and its record on
 * hover. Choosing a task opens its view, its thread under its record; a task without a thread yet
 * opens the newest message that cites its ID.
 */
export function TeamTasks({
  tasks,
  artifacts,
  view,
  onViewChange,
}: {
  tasks: TeamTask[];
  artifacts: TeamArtifact[];
  view: TaskView;
  onViewChange: (view: TaskView) => void;
}) {
  const { teamId, agents, presence, openArtifact, openMessage, openThread } = useTeamPane();
  const lookup = useMutation({
    mutationFn: ({ id }: TeamTask) => findTeamTaskMessage({ data: { teamId, taskId: id } }),
    onSuccess: (location) => {
      if (location) openMessage(location);
    },
  });
  const openTask = (task: TeamTask) =>
    task.threadSequence ? openThread(task.threadSequence) : lookup.mutate(task);
  const tree = teamTaskTree(tasks);
  const closedCount = tree.filter((task) => !isTeamTaskOpen(task)).length;
  const diff = teamTasksDiff(tasks);
  const { show, empty } = VIEWS.find(({ value }) => value === view)!;

  return (
    <section aria-label="Task list" className="flex h-full min-h-0 min-w-0 flex-col bg-panel">
      <TeamPanelHeader icon={ListChecks} title="Task list">
        <Badge variant="count">
          {closedCount}/{tree.length}
        </Badge>
        {diff && <TaskDiff diff={diff} />}
        <div className="ml-auto">
          <ViewMenu name="Task view" views={VIEWS} view={view} onViewChange={onViewChange} />
        </div>
      </TeamPanelHeader>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {lookup.data === null && (
          <p role="status" className="mb-3 text-xs text-muted-foreground">
            No message mentions {lookup.variables?.id} yet.
          </p>
        )}
        {lookup.error && (
          <p role="alert" className="mb-3 text-xs text-destructive">
            Unable to find a message about {lookup.variables?.id}: {lookup.error.message}
          </p>
        )}
        {tree.length > 0 ? (
          <Checklist
            items={teamTaskItems({
              tasks: tree,
              owners: agents,
              artifacts,
              presence,
              onArtifactOpen: (artifact) => openArtifact(artifact.file),
              onTaskSelect: openTask,
            })}
            show={show}
            empty={empty && <p className="text-sm text-muted-foreground italic">{empty}</p>}
            className="text-sm"
          />
        ) : (
          <p className="text-sm text-muted-foreground italic">No tasks yet.</p>
        )}
      </div>
    </section>
  );
}
