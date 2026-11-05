import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { teamQueries } from "@teams/queries";
import type { SessionUsage } from "@sessions/model/usage";
import { teamAgentIdentity, teamLead, type Team, type TeamMember } from "@teams/model";
import { TeamMembers } from "./TeamMembers";
import { TeamPaneProvider } from "./TeamPaneContext";

test("the team table includes lead and members, nested work, waiting details and model settings", () => {
  const team: Team = {
    id: "team",
    name: "Release",
    paused: false,
    model: { provider: "copilot", name: "claude-opus-5.5", reasoningEffort: "high" },
    tasks: [
      {
        id: "t1",
        title: "Ship release",
        status: "in_progress",
        ownerId: "team",
        children: [
          { id: "t2", title: "Implement feature", status: "in_progress", ownerId: "builder" },
          { id: "t3", title: "Write docs", status: "pending", ownerId: "builder" },
          { id: "t4", title: "Review API", status: "blocked", ownerId: "critic" },
          { id: "t5", title: "Old completed task", status: "done", ownerId: "builder" },
        ],
      },
    ],
    latestSequence: 0,
    seenThrough: 0,
    completedSequence: null,
    requestSequence: null,
    updatedAt: "2026-10-29T20:00:00Z",
  };
  const lead = teamLead(team.id);
  const members: TeamMember[] = [
    { id: "critic", teamId: team.id, name: "Critic" },
    {
      id: "builder",
      teamId: team.id,
      name: "Builder",
      role: "Build integration features",
      model: { provider: "codex", name: "gpt-6", reasoningEffort: "xhigh" },
    },
  ];
  const agents = [lead, ...members];
  const noop = () => {};
  const client = new QueryClient();
  client.setQueryData(teamQueries.usage(team.id).queryKey, {
    team: { aiCredits: 1.25, status: "complete" },
    builder: { aiCredits: 2.5, status: "complete" },
    critic: { aiCredits: 0, status: "complete" },
    removed: { aiCredits: 100, status: "complete" },
  });
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TeamPaneProvider
        value={{
          teamId: team.id,
          lead,
          members,
          agents,
          agent: (id) => teamAgentIdentity(agents, id),
          presence: {
            team: { state: "working" },
            builder: { state: "working", text: "Investigating a long diagnostic from the build" },
            critic: { state: "waiting", text: "API decision", wakeAt: "2026-10-29T21:00:00Z" },
          },
          openThread: noop,
          replyInThread: noop,
          isSending: () => false,
          mention: noop,
          openArtifact: noop,
          openArtifacts: noop,
          openMembers: noop,
        }}
      >
        <TeamMembers team={team} onClose={noop} />
      </TeamPaneProvider>
    </QueryClientProvider>,
  );

  for (const text of [
    "Team members (3)",
    "Ship release",
    "Implement feature",
    "Write docs",
    "Review API",
    "API decision",
    "checks back at",
    "claude-opus-5.5 (High)",
    "gpt-6 (Extra High)",
    "Workspace default",
  ]) {
    expect(html).toContain(text);
  }
  expect(html).not.toContain("Old completed task");
  expect(html).not.toContain(lead.role);
  expect(html).not.toContain("Build integration features");
  expect(html).not.toContain("Investigating a long diagnostic from the build");
  expect(html.match(/Waiting for API decision/g)).toHaveLength(1);
  expect(html.indexOf("Builder")).toBeLessThan(html.indexOf("Critic"));
  for (const agent of agents) expect(html).toContain(`aria-label="Actions for ${agent.name}"`);
  expect(html).toContain('aria-label="Actions for Members"');
  expect(html).not.toContain("AI credits");
});

function renderUsage(usage?: SessionUsage) {
  const team: Team = {
    id: "team",
    name: "Team",
    paused: false,
    model: { provider: "copilot", name: "test" },
    tasks: [],
    latestSequence: 0,
    seenThrough: 0,
    completedSequence: null,
    requestSequence: null,
    updatedAt: "2026-11-02T20:00:00Z",
  };
  const lead = teamLead(team.id);
  const noop = () => {};
  const client = new QueryClient();
  if (usage) client.setQueryData(teamQueries.usage(team.id).queryKey, { team: usage });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TeamPaneProvider
        value={{
          teamId: team.id,
          lead,
          members: [],
          agents: [lead],
          agent: () => lead,
          presence: {},
          openThread: noop,
          replyInThread: noop,
          isSending: () => false,
          mention: noop,
          openArtifact: noop,
          openArtifacts: noop,
          openMembers: noop,
        }}
      >
        <TeamMembers team={team} onClose={noop} />
      </TeamPaneProvider>
    </QueryClientProvider>,
  );
}

test("credits stay hidden by default with cold, complete, partial or unavailable cached usage", () => {
  for (const usage of [
    undefined,
    { aiCredits: 0, status: "unavailable" as const },
    { aiCredits: 0, status: "complete" as const },
    { aiCredits: 2.125, status: "partial" as const },
    { aiCredits: 1e-9, status: "complete" as const },
  ]) {
    const html = renderUsage(usage);
    for (const text of [
      "AI credits",
      "Reported usage",
      "Not reported",
      "Loading...",
      "(partial)",
      "Retry",
    ]) {
      expect(html).not.toContain(text);
    }
  }
});
