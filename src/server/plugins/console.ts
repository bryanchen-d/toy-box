import { definePlugin } from "nitro";
import { getProcessValue } from "@/shared/server/processState";
import { serverConsoleLine } from "../console";

export default definePlugin(() => {
  // Dev restarts rerun plugins in the same process, so wrap the console only once.
  getProcessValue("server-console", () => {
    for (const level of ["error", "warn"] as const) {
      const write = console[level].bind(console);
      console[level] = (...args: unknown[]) => {
        const line = serverConsoleLine(args, new Date());
        if (line) write(...line);
      };
    }
    return true;
  });
});
