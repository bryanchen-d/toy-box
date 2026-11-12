// Classifies agent actions for the security policy: which ones bring in content written by someone
// other than the owner, and which ones could do harm if that content steered the agent.
// Shell commands are matched by pattern, so obfuscated commands can slip past.

import type { AgentAction } from ".";

export type ActionRiskKind = "send" | "secrets" | "destructive" | "persistence";

/** Why an action needs the owner's approval once untrusted content may be steering the agent. */
export type ActionRisk = { kind: ActionRiskKind; description: string };

/** MCP servers that Agent Teams registers itself and that return nothing written by others. */
const TRUSTED_MCP_SERVERS = new Set(["agent_teams", "computer-use"]);

/** Commands whose output is mostly content written by other people. */
const UNTRUSTED_COMMANDS = [
  /\bgh\s+(issue|pr)\s+(view|list|diff|checks|status)\b/i,
  /\bgh\s+run\s+(view|list|watch)\b/i,
  /\bgh\s+(release|gist|repo|discussion)\s+(view|list)\b/i,
  /\bgh\s+(search|api)\b/i,
];

/** Web clients, which matter only when they reach beyond this machine. */
const WEB_CLIENTS = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;

const LOCAL_HOSTS = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1?\])(:\d+)?$/i;

const PERSISTENCE_PATHS = [
  /(^|[\s"'`/\\])(AGENTS|CLAUDE|GEMINI)\.md\b/i,
  /\.github[/\\]copilot-instructions\.md/i,
  /\bSKILL\.md\b/i,
  /(^|[\s"'`/\\])\.(agents|claude|copilot|codex|cursor)[/\\]/i,
  /\.git[/\\]hooks[/\\]/i,
  /\.vscode[/\\](settings|tasks|mcp)\.json/i,
  /\bmcp-config\.json\b/i,
  /(^|[\s"'`/\\])\.(bashrc|zshrc|bash_profile|profile)\b/i,
  /Microsoft\.PowerShell_profile\.ps1|\$PROFILE\b/i,
];

const FILE_WRITES =
  />|\btee\b|\b(Set-Content|Add-Content|Out-File|New-Item|Copy-Item|Move-Item)\b|\b(cp|mv)\s|\bsed\s+-i|\bln\s+-s/i;

// The first matching risk describes a command. Web-client risks apply only to remote requests.
const COMMAND_RISKS: readonly (readonly [RegExp, ActionRisk, { web?: true }?])[] = [
  [
    /\brm\s+-[a-z]*[rf][a-z]*\b|\brm\s+--(recursive|force)\b/i,
    { kind: "destructive", description: "delete files" },
  ],
  [/\bRemove-Item\b[^\n]*-Recurse\b/i, { kind: "destructive", description: "delete files" }],
  [/\b(rmdir|rd|del|erase)\s+\/[sq]\b/i, { kind: "destructive", description: "delete files" }],
  [
    /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f[a-z]*|branch\s+-D)\b/,
    { kind: "destructive", description: "discard Git work" },
  ],
  [
    /\bgit\s+push\b[^\n]*(\s--force\b|\s--force-with-lease\b|\s-f\b|\s\+\S)/i,
    { kind: "destructive", description: "force-push over remote history" },
  ],
  [
    /\bgh\s+(repo|release)\s+delete\b/i,
    { kind: "destructive", description: "delete GitHub resources" },
  ],
  [/\bmkfs\b|\bdd\s+if=/i, { kind: "destructive", description: "overwrite a disk" }],
  [
    /(^|[\s"'`/\\=])\.env(?!\.(example|sample|template)\b)(\.[\w.-]+)?\b/i,
    { kind: "secrets", description: "read environment secrets" },
  ],
  [
    /\b(id_rsa|id_ed25519|id_ecdsa|id_dsa)\b|[/\\]\.ssh[/\\]|\.aws[/\\]credentials|\.(npmrc|netrc|pypirc|git-credentials)\b|\.docker[/\\]config\.json|\.kube[/\\]config/i,
    { kind: "secrets", description: "read credentials" },
  ],
  [
    /\bgh\s+auth\s+token\b|--show-token\b|\bgit\s+credential\b|\bprintenv\b|^\s*env\s*$|\b(Get-ChildItem|gci|dir|ls)\s+env:|\bfind-(generic|internet)-password\b|\bcmdkey\s+\/list\b|\bget-access-token\b|\bprint-access-token\b/im,
    { kind: "secrets", description: "read credentials" },
  ],
  [/\bgit\s+push\b/i, { kind: "send", description: "push commits to a remote" }],
  [
    /\bgh\s+(pr|issue)\s+(create|comment|edit|close|reopen|merge|review|ready|delete|lock|transfer)\b/i,
    { kind: "send", description: "change GitHub issues or pull requests" },
  ],
  [
    /\bgh\s+(release|gist|repo|secret|variable|workflow|label|project)\s+(create|upload|edit|delete|fork|set|run|rename|archive)\b/i,
    { kind: "send", description: "change GitHub" },
  ],
  [
    /\bgh\s+api\b[^\n]*(\s(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b|\s(-f|-F|--field|--raw-field|--input)\s)/i,
    { kind: "send", description: "send a GitHub API request" },
  ],
  [
    /\bcurl\b[^\n]*(\s(-d|-F|-T)\b|\s--(data[\w-]*|form|upload-file|json)\b|\s(-X|--request)\s*(POST|PUT|PATCH|DELETE)\b)/i,
    { kind: "send", description: "send data to a web service" },
    { web: true },
  ],
  [
    /\bwget\b[^\n]*--(post-data|post-file|method)\b/i,
    { kind: "send", description: "send data to a web service" },
    { web: true },
  ],
  [
    /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]*(-Method\s+['"]?(Post|Put|Patch|Delete)\b|-Body\b|-InFile\b)/i,
    { kind: "send", description: "send data to a web service" },
    { web: true },
  ],
  [
    /\b(npm|pnpm|yarn|bun|cargo|twine|gem)\s+(publish|upload|push)\b/i,
    { kind: "send", description: "publish a package" },
  ],
  [
    /\b(scp|sftp|ftp|nc|ncat|netcat|telnet)\s|\brsync\b[^\n]*\s\S+:|\bssh\s+\S/i,
    { kind: "send", description: "copy data to another machine" },
  ],
  [/\b(Send-MailMessage|sendmail)\b/i, { kind: "send", description: "send email" }],
];

const MCP_WRITE_TOOLS =
  /(^|[_-])(create|update|delete|add|post|send|merge|push|comment|edit|close|reopen|upload|publish|write|remove|assign|submit|reply|react|fork|approve|dismiss|request|run|trigger|dispatch|cancel|rerun)([_-]|$)|^(Send|Post|Create|Update|Delete|Reply|Add|Remove|Set|Upload)[A-Z]/;

/** Where an action's result came from when other people wrote it, or undefined when it's trusted. */
export function untrustedSource(action: AgentAction): string | undefined {
  switch (action.type) {
    case "fetch":
      return isLocalUrl(action.url) ? undefined : `the web page ${action.url}`;
    case "search":
      return `web search results for "${action.query}"`;
    case "mcp":
      return TRUSTED_MCP_SERVERS.has(action.server)
        ? undefined
        : `${action.server} (${action.tool})`;
    case "command":
      return UNTRUSTED_COMMANDS.some((pattern) => pattern.test(action.command)) ||
        (WEB_CLIENTS.test(action.command) && reachesRemote(action.command))
        ? `the output of \`${firstLine(action.command)}\``
        : undefined;
    default:
      return undefined;
  }
}

/** What harm an action could do if untrusted content steered it, or undefined when it's benign. */
export function actionRisk(action: AgentAction): ActionRisk | undefined {
  switch (action.type) {
    case "command": {
      const risk = COMMAND_RISKS.find(
        ([pattern, , options]) =>
          pattern.test(action.command) && (!options?.web || reachesRemote(action.command)),
      )?.[1];
      if (risk) return risk;
      return PERSISTENCE_PATHS.some((pattern) => pattern.test(action.command)) &&
        FILE_WRITES.test(action.command)
        ? { kind: "persistence", description: "change agent instructions or configuration" }
        : undefined;
    }
    case "write":
      return action.paths.some((path) => PERSISTENCE_PATHS.some((pattern) => pattern.test(path)))
        ? { kind: "persistence", description: "change agent instructions or configuration" }
        : undefined;
    case "mcp":
      return !TRUSTED_MCP_SERVERS.has(action.server) && MCP_WRITE_TOOLS.test(action.tool)
        ? { kind: "send", description: `send or change data through ${action.server}` }
        : undefined;
    default:
      return undefined;
  }
}

/** A short, single-line description of what an action does, for approval prompts and records. */
export function describeAction(action: AgentAction): string {
  switch (action.type) {
    case "command":
      return action.command.trim();
    case "fetch":
      return `fetch ${action.url}`;
    case "search":
      return `search the web for "${action.query}"`;
    case "mcp":
      return `${action.server} ${action.tool}`;
    case "write":
      return `write ${action.paths.join(", ")}`;
    case "tool":
      return action.name;
  }
}

/** Whether a command names any web address beyond this machine, or names none it can check. */
function reachesRemote(command: string): boolean {
  const urls = command.match(/https?:\/\/[^\s"'`)]+/gi);
  return !urls || urls.some((url) => !isLocalUrl(url));
}

function isLocalUrl(url: string): boolean {
  const host = /^https?:\/\/([^/?#]+)/i.exec(url)?.[1];
  return host !== undefined && LOCAL_HOSTS.test(host.replace(/^[^@]*@/, ""));
}

function firstLine(text: string, length = 120): string {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}
