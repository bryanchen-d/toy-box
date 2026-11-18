import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createEmptyWorkspaceState } from "@workspace/model/state/reducer";
import { workspaceQueries } from "@workspace/queries";
import { SettingsButton } from "./SidebarActions";
import { SidebarFooter } from "./SidebarFooter";
import { SidebarRail } from "./SidebarRail";

function renderSidebarTools(showSidebarTools: boolean) {
  const queryClient = new QueryClient();
  const workspace = createEmptyWorkspaceState();
  queryClient.setQueryData(workspaceQueries.stateKey(), {
    ...workspace,
    settings: { ...workspace.settings, showSidebarTools },
  });
  const actions = {
    onBrowseFiles: () => {},
    onBrowseScreens: () => {},
    onToggleHyper: () => {},
    isHyperOpen: true,
    onToggleTerminal: () => {},
    isTerminalOpen: true,
  };

  return [
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarFooter {...actions} leadingSlot={<SettingsButton onOpenSettings={() => {}} />} />
      </QueryClientProvider>,
    ),
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarRail
          {...actions}
          collapsed
          onCreateSession={() => {}}
          onCreateAutomation={() => {}}
          onCreateTeam={() => {}}
        >
          <span>Team tabs</span>
        </SidebarRail>
      </QueryClientProvider>,
    ),
  ];
}

test("hides sidebar tools in both layouts even when their surfaces are open", () => {
  const [footer, rail] = renderSidebarTools(false);
  for (const markup of [footer, rail]) {
    expect(markup).not.toContain('aria-label="Toggle hyper session"');
    expect(markup).not.toContain('aria-label="Browse"');
    expect(markup).not.toContain('aria-label="Toggle terminal"');
  }
  expect(footer).toContain('aria-label="Edit settings"');
  expect(rail).toContain("Team tabs");
  expect(rail).toContain('aria-label="Create team"');
});

test("restores all sidebar tools in both layouts on opt-in", () => {
  for (const markup of renderSidebarTools(true)) {
    expect(markup).toContain('aria-label="Toggle hyper session"');
    expect(markup).toContain('aria-label="Browse"');
    expect(markup).toContain('aria-label="Toggle terminal"');
    expect(markup).toContain('aria-pressed="true"');
  }
});
