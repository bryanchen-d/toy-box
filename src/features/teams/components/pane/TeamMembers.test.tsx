import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { teamQueries } from "@teams/queries";
import { sessionQueries } from "@sessions/queries";
import type { SessionUsage } from "@sessions/model/usage";
import { workspaceQueries } from "@workspace/queries";
import { createEmptyWorkspaceState } from "@workspace/model/state/reducer";
import { WorkspaceSurfaceProvider } from "@workspace/hooks/layout/surface";
import { teamAgentIdentity, teamLead, type Team, type TeamMember } from "@teams/model";
import { teamTask } from "@teams/model/testFixtures";
import { TeamMembers } from "./TeamMembers";
import { TeamPaneProvider } from "./TeamPaneContext";

test("the team table includes lead and members, nested work and waiting details, without models by default", () => {
  const team: Team = {
    id: "team",
    name: "Release",
    paused: false,
    model: { provider: "copilot", name: "claude-opus-5.5", reasoningEffort: "high" },
    latestSequence: 0,
    seenThrough: 0,
    completedSequence: null,
    requestSequence: null,
    updatedAt: "2026-10-29T20:00:00Z",
  };
  const tasks = [
    teamTask("t1", { title: "Ship release", status: "in_progress", assigneeId: "team" }),
    ...(
      [
        ["t2", "Implement feature", "in_progress", "builder"],
        ["t3", "Write docs", "pending", "builder"],
        ["t4", "Review API", "blocked", "critic"],
        ["t5", "Old completed task", "completed", "builder"],
      ] as const
    ).map(([id, title, status, assigneeId], position) =>
      teamTask(id, { parentId: "t1", position, title, status, assigneeId }),
    ),
  ];
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
  const subSession = {
    id: "render-check",
    title: "Render check",
    provider: { id: "node:brchen-db3" },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  client.setQueryData(sessionQueries.stateKey(), {
    sessions: [subSession],
    worktrees: {},
    ownership: { [subSession.id]: { type: "worker", parentSessionId: "builder" } },
  });
  client.setQueryData(workspaceQueries.stateKey(), {
    ...createEmptyWorkspaceState(),
    sessionStates: { [subSession.id]: { status: "running", since: 0 } },
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
          openMessage: noop,
          replyInThread: noop,
          isSending: () => false,
          openArtifact: noop,
          openPanel: noop,
        }}
      >
        <WorkspaceSurfaceProvider surface="main" panes={[]} onOpenApp={noop}>
          <TeamMembers team={team} tasks={tasks} />
        </WorkspaceSurfaceProvider>
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
    "Render check",
    "On brchen-db3 · Working",
    "Preview Builder&#x27;s session · 1 sub session · 1 working · 1 on brchen-db3",
  ]) {
    expect(html).toContain(text);
  }
  expect(html).not.toContain("Old completed task");
  expect(html).not.toContain(lead.role);
  expect(html).not.toContain("Build integration features");
  expect(html).not.toContain("Investigating a long diagnostic from the build");
  for (const text of ["claude-opus-5.5", "gpt-6", "Workspace default"]) {
    expect(html).not.toContain(text);
  }
  expect(html.match(/Waiting for API decision/g)).toHaveLength(1);
  expect(html.indexOf("Builder")).toBeLessThan(html.indexOf("Critic"));
  // Each name opens its editor; the header holds the roster's actions, so rows have no menus.
  for (const agent of agents) {
    expect(html).toContain(`aria-label="Edit ${agent.name}"`);
    expect(html).not.toContain(`aria-label="Actions for ${agent.name}"`);
  }
  for (const label of ["Add an agent", "Edit team", "Actions for Members"]) {
    expect(html).toContain(`aria-label="${label}"`);
  }
  expect(html).not.toContain("AI credits");
});

function renderUsage(usage?: SessionUsage) {
  const team: Team = {
    id: "team",
    name: "Team",
    paused: false,
    model: { provider: "copilot", name: "test" },
    latestSequence: 0,
    seenThrough: 0,
    completedSequence: null,
    requestSequence: null,
    updatedAt: "2026-11-02T20:00:00Z",
  };
  const lead = teamLead(team.id);
  const noop = () => {};
  const client = new QueryClient();
  client.setQueryData(workspaceQueries.stateKey(), createEmptyWorkspaceState());
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
          openMessage: noop,
          replyInThread: noop,
          isSending: () => false,
          openArtifact: noop,
          openPanel: noop,
        }}
      >
        <TeamMembers team={team} tasks={[]} />
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
