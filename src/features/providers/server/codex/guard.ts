// Codex can neither rewrite tool results nor hold calls through its app-server, so Agent Teams
// observes completed items instead: untrusted results still expose the session and record attacks.

import type { AgentAction } from "@security/model";
import type { ItemCompletedNotification } from "./protocol";

type CompletedItem = ItemCompletedNotification["item"];

/** The action behind a completed item and the text it returned, when it can bring in content. */
export function codexObservedResult(
  item: CompletedItem,
): { action: AgentAction; text: string } | undefined {
  switch (item.type) {
    case "commandExecution":
      return {
        action: { type: "command", command: item.command },
        text: item.aggregatedOutput ?? "",
      };
    case "mcpToolCall":
      return {
        action: { type: "mcp", server: item.server, tool: item.tool },
        text: (item.result?.content ?? [])
          .flatMap((block) =>
            block && typeof block === "object" && "text" in block && typeof block.text === "string"
              ? [block.text]
              : [],
          )
          .join("\n"),
      };
    case "webSearch":
      return {
        action:
          item.action?.type === "openPage" && item.action.url
            ? { type: "fetch", url: item.action.url }
            : { type: "search", query: item.query },
        text: item.results ? JSON.stringify(item.results) : "",
      };
    default:
      return undefined;
  }
}
