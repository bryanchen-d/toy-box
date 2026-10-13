import { z } from "zod";
import { defineTool } from "@sessions/server/tools/definition";
import { filterScreenWindows } from "../model";
import { screenRuntime } from "./runtime";

export const screenTools = [
  defineTool("list_screens", {
    description:
      "Lists displays and windows so you can show one to the user with set_session_preview. Displays are always listed; query filters windows by title or application. To operate apps, use your computer-use tools or playwright-cli.",
    parameters: z.object({ query: z.string().optional() }).strict(),
    handler: async ({ query }) => {
      const { displays, windows } = await screenRuntime.list();
      return { displays, windows: filterScreenWindows(windows, query) };
    },
  }),
] as const;
