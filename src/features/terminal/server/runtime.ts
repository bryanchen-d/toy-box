import { PTYManager } from "./pty";
import { getProcessValue } from "@/shared/server/processState";

// Keep process-global construction separate from the testable PTY lifecycle.
export const terminalRuntime = getProcessValue("terminal-runtime", () => new PTYManager());
