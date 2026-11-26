import { ListChecks, ListTodo, LoaderCircle, MessageCircleQuestionMark } from "lucide-react";
import {
  isTeamTaskOpen,
  teamTasksDiff,
  teamTasksNeedingInput,
  teamTaskTree,
  type TeamArtifact,
  type TeamPendingRequest,
  type TeamTask,
} from "@teams/model";
import { Badge } from "@/shared/ui/badge";
import { Checklist, isChecklistItemFinished, type ChecklistItem } from "@/shared/ui/checklist";
import { useTeamPane } from "./TeamPaneContext";
import { TeamPanelHeader } from "./TeamPanelHeader";
import { teamTaskItems, TaskDiff } from "./teamTaskItems";
import { ViewMenu, type ViewOption } from "./ViewMenu";

/**
 * Which tasks the panel shows: open ones, only those in progress, those whose thread holds a
 * question for you, or all of them.
 */
export type TaskView = "open" | "in_progress" | "input" | "all";

const VIEWS: (ViewOption<TaskView> & {
  show?: (item: ChecklistItem, needsInput: ReadonlySet<string>) => boolean;
  empty?: string;
})[] = [
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
  {
    value: "input",
    label: "Needs your input",
    Icon: MessageCircleQuestionMark,
    show: ({ id }, needsInput) => needsInput.has(id),
    empty: "No task is waiting on you.",
  },
  { value: "all", label: "All tasks", Icon: ListChecks },
];

/**
 * The team's task list, with each task's assignee, artifact, and reported diff, and its record on
 * hover. Choosing a task opens its view, its thread under its record, even before it has one.
 */
export function TeamTasks({
  tasks,
  artifacts,
  pendingRequests,
  view,
  onViewChange,
  onOpenTask,
}: {
  tasks: TeamTask[];
  artifacts: TeamArtifact[];
  /** The questions waiting on the user, whose task threads need your input. */
  pendingRequests: readonly TeamPendingRequest[];
  view: TaskView;
  onViewChange: (view: TaskView) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { agents, presence, openArtifact } = useTeamPane();
  const tree = teamTaskTree(tasks);
  const closedCount = tree.filter((task) => !isTeamTaskOpen(task)).length;
  const diff = teamTasksDiff(tasks);
  const needsInput = new Set(teamTasksNeedingInput(tasks, pendingRequests).map(({ id }) => id));
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
        {tree.length > 0 ? (
          <Checklist
            items={teamTaskItems({
              tasks: tree,
              owners: agents,
              artifacts,
              presence,
              onArtifactOpen: (artifact) => openArtifact(artifact.file),
              onTaskSelect: ({ id }) => onOpenTask(id),
            })}
            show={show && ((item) => show(item, needsInput))}
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
