import { Scanner } from "@tailwindcss/oxide";
import { compile } from "tailwindcss";

import tailwindTheme from "tailwindcss/theme.css?raw";
import agentTeamsTheme from "@/shared/ui/theme.css?raw";

const TAILWIND_THEME = "tailwind-theme";
const AGENT_TEAMS_THEME = "agent-teams-theme";

export async function compileAppStyles(source: { id: string; tsx: string }): Promise<string> {
  const compiler = await compile(
    `
      @reference "${TAILWIND_THEME}";
      @reference "${AGENT_TEAMS_THEME}";
      [data-agent-teams-app="${source.id}"] { @tailwind utilities; }
    `,
    {
      loadStylesheet: async (id) => {
        const content =
          id === TAILWIND_THEME
            ? tailwindTheme
            : id === AGENT_TEAMS_THEME
              ? agentTeamsTheme
              : undefined;
        if (content === undefined) throw new Error(`Unsupported app stylesheet import "${id}".`);
        return { path: id, base: "", content };
      },
    },
  );
  const candidates = new Scanner({ sources: [] }).scanFiles([
    { content: source.tsx, extension: "tsx" },
  ]);
  return compiler.build(candidates);
}
