import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Lightbulb } from "lucide-react";
import type { TeamAdvice as Advice, TeamAdviceAction } from "@teams/model/advice";
import type { Team } from "@teams/model";
import { teamMutations } from "@teams/mutations";
import { teamQueries } from "@teams/queries";
import { AgentMentionMarkdown } from "@teams/components/agents/AgentMentionMarkdown";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { RelativeTime } from "@/shared/ui/relative-time";
import { useTeamPane } from "./TeamPaneContext";

/** What a request to the lead for an auditor asks, so advice starts arriving. */
const AUDITOR_REQUEST =
  "@lead Please set up a performance auditor: a member that reviews read_team_performance and our transcript on a routine targeted at it, and proposes concrete improvements with propose_team_advice.";

/** Advice agents proposed for how the team works; only the user applies or dismisses it. */
export function TeamAdvice({
  team,
  advice,
  onAskLead,
}: {
  team: Team;
  advice: readonly Advice[];
  onAskLead: (content: string) => Promise<unknown>;
}) {
  const open = advice.filter(({ status }) => status === "open");
  const resolved = advice.filter(({ status }) => status !== "open");
  const [asked, setAsked] = useState(false);

  return (
    <div className="space-y-4 p-4 text-sm">
      {open.length === 0 ? (
        <div className="space-y-2 rounded-md border border-dashed p-4 text-center">
          <Lightbulb className="mx-auto size-5 text-muted-foreground" aria-hidden />
          <p className="text-muted-foreground">
            No open advice. A performance auditor proposes improvements from these stats.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={team.paused || asked}
            onClick={() => void onAskLead(AUDITOR_REQUEST).then(() => setAsked(true))}
          >
            {asked ? "Request sent" : "Ask the lead to set up an auditor"}
          </Button>
        </div>
      ) : (
        <ul aria-label="Open advice" className="space-y-3">
          {open.map((item) => (
            <AdviceCard key={item.id} teamId={team.id} advice={item} />
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <section aria-label="Resolved advice" className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">Resolved</h3>
          <ul className="space-y-1 text-xs">
            {resolved.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <Badge variant={item.status === "applied" ? "secondary" : "outline"}>
                  {item.status === "applied" ? "Applied" : "Dismissed"}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{item.title}</span>
                {item.resolvedAt && (
                  <RelativeTime
                    className="text-muted-foreground"
                    date={new Date(item.resolvedAt)}
                  />
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AdviceCard({ teamId, advice }: { teamId: string; advice: Advice }) {
  const { agent } = useTeamPane();
  const resolve = useMutation(teamMutations.resolveAdvice(teamId));
  const author = agent(advice.authorId);

  return (
    <li className="space-y-2 rounded-md border bg-background p-3">
      <div>
        <h3 className="font-medium">{advice.title}</h3>
        <p className="text-xs text-muted-foreground">
          Proposed by {author.name} <RelativeTime date={new Date(advice.createdAt)} />
        </p>
      </div>
      <div className="text-xs">
        <AgentMentionMarkdown content={advice.finding} />
      </div>
      <p className="rounded bg-muted/50 px-2 py-1.5 text-xs">
        <span className="font-medium">Apply: </span>
        <ActionSummary action={advice.action} />
      </p>
      {resolve.error && (
        <p role="alert" className="text-xs text-destructive">
          Unable to resolve this advice: {resolve.error.message}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ adviceId: advice.id, resolution: "apply" })}
        >
          {resolve.isPending && resolve.variables?.resolution === "apply" ? "Applying…" : "Apply"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ adviceId: advice.id, resolution: "dismiss" })}
        >
          Dismiss
        </Button>
      </div>
    </li>
  );
}

/** What applying does, said plainly before the user commits to it. */
function ActionSummary({ action }: { action: TeamAdviceAction }) {
  const { agent, lead } = useTeamPane();
  const { data: catalog } = useQuery(teamQueries.list());
  if (action.type === "message_lead") {
    return (
      <>
        tells {lead.name}: “{action.content}”
      </>
    );
  }
  const names = action.agentIds.map((id) => agent(id).name).join(", ");
  const target =
    "teamId" in action.to
      ? (catalog?.teams.find(({ id }) => id === (action.to as { teamId: string }).teamId)?.name ??
        "a team that no longer exists")
      : `a new team “${action.to.newTeam.name}” with its own lead`;
  return (
    <>
      moves {names} to {target}.
    </>
  );
}
