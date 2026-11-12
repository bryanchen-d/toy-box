import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, Loader2, ShieldAlert } from "lucide-react";
import { Badge } from "@/shared/ui/badge";
import { Button } from "@/shared/ui/button";
import { Input } from "@/shared/ui/input";
import { Markdown } from "@/shared/ui/markdown";
import { RelativeTime } from "@/shared/ui/relative-time";
import { cn } from "@/shared/utils";
import type { FindingExchange, FindingOutcome, SecurityFinding } from "../model";
import { securityMutations } from "../mutations";

const DEFAULT_QUESTION = "Explain this finding in more detail.";
const OUTCOME_LABELS: Record<FindingOutcome, string> = {
  "false-positive": "Not an attack",
  attack: "Real attack",
};

/**
 * One finding as the user handles it: what it tried, where it was found, the passage that does
 * it, and why that's risky, with questions answered by the tool-less model that screened it. An
 * open finding can warn its agent or be closed with the user's verdict; a closed one folds away
 * and can be reopened.
 */
export function SecurityFindingCard({
  finding,
  where,
  onSessionOpen,
}: {
  finding: SecurityFinding;
  /** The session it was found in, such as a team agent's name. */
  where?: string;
  onSessionOpen?: () => void;
}) {
  const close = useMutation(securityMutations.close(finding.id));
  const reopen = useMutation(securityMutations.reopen(finding.id));
  const warn = useMutation(securityMutations.warn(finding));
  const explain = useMutation(securityMutations.explain(finding.id));
  // Answers last as long as the card; the finding itself is the durable record.
  const [exchanges, setExchanges] = useState<FindingExchange[]>([]);
  const [question, setQuestion] = useState("");
  const { closed } = finding;
  const changing = close.isPending || reopen.isPending;
  const error = explain.error ?? warn.error ?? close.error ?? reopen.error;

  function ask(event: FormEvent) {
    event.preventDefault();
    const asked = question.trim();
    explain.mutate(
      { question: asked, earlier: exchanges.slice(-5) },
      {
        onSuccess: (answer) => {
          setExchanges((current) => [...current, { question: asked || DEFAULT_QUESTION, answer }]);
          setQuestion("");
        },
      },
    );
  }

  const header = (
    <header className="flex items-start gap-2">
      <ShieldAlert
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0",
          closed ? "text-muted-foreground" : "text-destructive",
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="font-medium">Tried to {finding.action}</h3>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {where ? `In ${where}, from ` : "From "}
          {finding.source} · <RelativeTime date={finding.detectedAt} />
        </p>
        {closed && (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <Badge variant="metadata">{OUTCOME_LABELS[closed.outcome]}</Badge>
            closed <RelativeTime date={closed.at} />
          </p>
        )}
      </div>
      {closed && (
        <ChevronRight
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
      )}
    </header>
  );

  const details = (
    <>
      <blockquote className="border-l-2 border-destructive/60 pl-3 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
        {finding.quote}
      </blockquote>
      <p>
        <span className="font-medium">Why it's risky: </span>
        {finding.reason}
      </p>
      {!closed && (
        <p className="text-xs text-muted-foreground">
          Until you close it, this session asks before sending data out, reading credentials,
          deleting work, or changing agent instructions, or is blocked when nobody can ask you.
        </p>
      )}

      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Show the content it came from
        </summary>
        <pre className="mt-2 max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
          {finding.excerpt}
        </pre>
      </details>

      {exchanges.map(({ question: asked, answer }, index) => (
        // eslint-disable-next-line react/no-array-index-key -- exchanges are only appended, so a position is an exchange
        <div key={index} className="space-y-1 border-t pt-3">
          <p className="text-xs font-medium text-muted-foreground">{asked}</p>
          <Markdown className="space-y-2 text-sm [&_:is(h1,h2,h3,h4)]:text-sm [&_:is(h1,h2,h3,h4)]:font-semibold">
            {answer}
          </Markdown>
        </div>
      ))}
      <form onSubmit={ask} className="flex gap-2">
        <Input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={exchanges.length ? "Ask a follow-up…" : "Ask why, or leave empty to explain"}
          aria-label="Ask about this finding"
          maxLength={1_000}
          className="h-8 text-sm"
        />
        <Button type="submit" size="sm" variant="outline" disabled={explain.isPending}>
          {explain.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {question.trim() || exchanges.length ? "Ask" : "Explain"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error.message}
        </p>
      )}

      <footer className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1">
          {onSessionOpen && (
            <Button type="button" size="sm" variant="ghost" onClick={onSessionOpen}>
              Open session
            </Button>
          )}
          {!closed && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              title="Tell the agent this content is an injection and not to act on it"
              disabled={warn.isPending || warn.isSuccess}
              onClick={() => warn.mutate()}
            >
              {warn.isSuccess ? "Agent warned" : "Warn agent"}
            </Button>
          )}
        </div>
        {closed ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            title="Open it again, which holds this session's risky actions"
            disabled={changing}
            onClick={() => reopen.mutate()}
          >
            Reopen
          </Button>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={changing}
              onClick={() => close.mutate("false-positive")}
            >
              Not an attack
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={changing}
              onClick={() => close.mutate("attack")}
            >
              Real attack, handled
            </Button>
          </div>
        )}
      </footer>
    </>
  );

  return (
    <article
      role="listitem"
      aria-label={`${closed ? "Closed" : "Open"} finding: tried to ${finding.action}`}
      className="rounded-lg border bg-background p-3 text-sm"
    >
      {closed ? (
        <details className="group">
          <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
            {header}
          </summary>
          <div className="mt-3 space-y-3">{details}</div>
        </details>
      ) : (
        <div className="space-y-3">
          {header}
          {details}
        </div>
      )}
    </article>
  );
}
