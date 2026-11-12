# Security

Agents read content written by people other than the owner: other people's Slack messages, GitHub
issues and pull requests, web pages, and MCP results. Any of it can try to steer an agent. Security
marks that content wherever an agent reads it, screens it for injection attempts, and keeps a record
of attacks for the user. Only a detected attack restricts anything: until the user closes it, its
session's risky actions are held.

Screening incoming text is the focus. Reading untrusted content never restricts tokens, data
requests, or pushes on its own, so agents keep their normal access to GitHub, Azure DevOps, Kusto,
and other services. The tradeoff is that an attack the judge misses isn't held.

## Domain model

```text
AgentAction       what a native tool call does: command, fetch, search, mcp, write, or tool
UntrustedContent  text from someone other than the owner, and its source
Screening         the judge's verdict: an attack, what it tries to make an agent do, the passage
                  that does it, and why that's risky
SecurityFinding   a durable record of flagged content; open, it holds its session, and the user
                  closes it as a false positive or a real attack
```

- `model/actions.ts` classifies actions. `untrustedSource` names where a result came from when
  other people wrote it: web pages and searches, MCP servers other than Agent Teams' own
  (`agent_teams`, `computer-use`), `gh` reads of issues, pull requests, runs, and the API, and web
  clients that reach beyond this machine. `actionRisk` names what an action could do if steered:
  send data out, read credentials, destroy work, or change agent instructions and configuration.
  Shell commands are matched by pattern, so obfuscated commands can slip past.
- `model/envelope.ts` wraps untrusted content after a line naming its source, between
  `<untrusted-content marker="…">` tags closed by the same random marker, so the content can't end
  the envelope early. Sources and verdicts are collapsed to one line without angle brackets.
  `UNTRUSTED_CONTENT_INSTRUCTIONS` teaches every session to read it.
- `model/policy.ts` is the gate. A risky action in a session with an open finding is asked
  about when someone can approve it and refused otherwise; the refusal tells the agent not to work
  around it. Without a finding, everything is allowed.

## Where content is labeled

- Copilot and Claude replace untrusted tool results through their post-tool hooks, so the model
  only ever sees the envelope, and its verdict is recorded before the model acts on it.
- Codex can't rewrite or hold tool activity through its app-server, so its connection screens
  completed root-thread commands, MCP calls, and web searches after the fact. That records attacks,
  but Codex actions are not gated, and its subagents' results aren't screened.
- Teams' `read_team` and `inspect_team` label content a connector forwards (`origin` set) from
  anyone but the owner. A connector's own notices carry no origin and stay trusted.
- Inbox's page tasks label the page's title and selection, apart from the user's task. The route
  screens them before dispatch, so the prompt carries the verdict and the finding exists when the
  task's session starts.

`receiveUntrustedContent` screens content, records a finding for an attack with `recordScreening`,
and returns the envelope. A finding keeps the judge's quote only when the content contains it,
ignoring whitespace; otherwise it quotes the content's start, so the passage shown is never the
model's invention.

## Screening

`server/judge.ts` asks a small model (Haiku, then mini, flash, nano, or lite) from any enabled
provider that implements `respond` for a JSON verdict. Copilot answers through a short-lived,
tool-less session that it deletes and hides from the catalog. Because a finding holds its session,
the instructions name ordinary work as not an attack: teammates and agents coordinating, tool, CI,
and log output with links and status lines, and discussion of injections or safeguards. Verdicts
are cached by content hash, at most two judgments run at once, and long content keeps its first
18,000 and last 6,000 characters. Screening fails open: without a verdict the content is still
labeled but holds nothing.

`explainFinding` answers the user's questions about a finding with the same tool-less model, the
content marked untrusted, and up to five earlier exchanges. A steered answer can mislead but can't
act. Answers last as long as the card that asked; the finding is the durable record.

## Gate and approvals

Sessions supplies each provider connection with `createSessionGuard` as its `toolGuard`.
`review` looks up the session's newest open finding only for risky actions. Interactive
sessions (standard and Hyper) ask through `SessionStream.requestApproval`, which adds a live
`ask_user` row with Allow and Deny; stopping the session or the held call declines. Managed
sessions (Teams, Automations, Inbox, Workers) can't ask, so their risky actions are refused until
the user closes the finding. Approval rows are live-only; a refusal reaches provider history as the
action's result.

## Persistence and reporting

`security_findings` keeps flagged content after its session is gone, once per session and content
hash. Findings survive restarts, so a held session stays held until the user closes its finding; a
session recreated under the same ID, like an Automation run, is held by its predecessor's open
findings too. Closing records the user's verdict, `false-positive` or `attack`; correcting it keeps
the closing time, and reopening clears both.

Clients hold open findings whole in `securityQueries.open()`, since each one holds a session and
the user closes them; it drives the panel bar's mark. The closed record only grows, so
`securityQueries.closed(sessionIds)` reads it 20 at a time, most recently closed first, resuming
after the last finding's closing time and ID. `security.finding.upserted` moves a finding between
the open list and every loaded closed list whose sessions include it, and reconnects refetch both.

Each Team pane's panel bar has a Security toggle, marked while one of its agents has an open
finding. The panel lists the Team's open findings, or every session's under All, then a folded
Closed section that loads its first page when unfolded and each next one as its end scrolls into
view. `SecurityFindingCard` shows what the content tried, the agent or session and source it
reached, the quoted passage, and why it's risky, with the full excerpt folded away, an Ask box, and
Open session. An open finding can be closed as Not an attack or Real attack, handled, and Warn
agent sends its session a `security_warning` system message telling the agent not to act on the
content and to report anything it already did; that wakes an idle session. A closed finding folds
to its title and verdict and can be reopened.

## Boundaries

- Agent-authored team messages are trusted, so untrusted content an agent relays to its team
  isn't relabeled.
- Fetches and searches are never gated, even though a URL can carry data out.
- Messages to connectors are not gated.
