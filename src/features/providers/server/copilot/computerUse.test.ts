import { expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { computerUseServers } from "./computerUse";

test("computer use is opt-in and uses the running CLI's version, not the npm loader's version", async () => {
  const home = await mkdtemp(join(tmpdir(), "toy-box-computer-"));
  const getStatus = mock(async () => ({ version: "1.0.96-2", protocolVersion: 2 }));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const settings = join(home, ".copilot/settings.json");
  const command = join(
    home,
    "Library/Caches/copilot/pkg",
    `${process.platform}-${process.arch}`,
    "1.0.96-2/plugins/computer-use/computer-use-mcp",
  );
  try {
    expect(await computerUseServers({ getStatus }, home)).toBeUndefined();
    await Bun.write(settings, JSON.stringify({ enabledMcpServers: [] }));
    expect(await computerUseServers({ getStatus }, home)).toBeUndefined();
    expect(getStatus).not.toHaveBeenCalled();
    await Bun.write(settings, JSON.stringify({ enabledMcpServers: ["computer-use"] }));
    expect(await computerUseServers({ getStatus }, home)).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("1.0.96-2 binary was not found"));
    await Bun.write(command, "");
    expect(await computerUseServers({ getStatus }, home)).toEqual({
      "computer-use": { type: "stdio", command, args: [], workingDirectory: dirname(command) },
    });
    await Bun.write(settings, "{");
    await expect(computerUseServers({ getStatus }, home)).rejects.toThrow();
  } finally {
    warn.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});
