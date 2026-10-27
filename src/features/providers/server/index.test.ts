import { afterEach, beforeEach, expect, mock, onTestFinished, spyOn, test } from "bun:test";
import { copilotProvider } from "./copilot/provider";
import { codexProvider } from "./codex/provider";
import * as cli from "./cli";
import type { ModelInfo } from "../model";
import type { Session } from "@sessions/model";
import * as workspaceSettings from "@workspace/server/state/settings";
import { DEFAULT_SETTINGS } from "@workspace/model/config/settings";
import { subscribeWorkspaceEvents } from "@workspace/server/events";
import {
  getProviderCatalog,
  listModels,
  listSessions,
  sessionProviders,
  stopProviders,
  updateProvider,
} from "./index";

const MODEL: ModelInfo = { id: "model", name: "Available model", provider: "codex" };
const SESSION: Session = { id: "native-session", createdAt: new Date(0), updatedAt: new Date(0) };

beforeEach(() => {
  spyOn(workspaceSettings, "getSettings").mockResolvedValue({
    ...DEFAULT_SETTINGS,
    disabledProviders: [],
  });
  spyOn(cli, "isInstalled").mockReturnValue(false);
  for (const provider of sessionProviders) spyOn(provider, "stop").mockResolvedValue();
});
afterEach(async () => {
  await stopProviders();
  mock.restore();
});

test("no installed providers returns empty catalogs without starting a provider", async () => {
  const readers = sessionProviders.flatMap((provider) => [
    spyOn(provider, "listModels"),
    spyOn(provider, "listSessions"),
  ]);
  expect(await listModels()).toEqual([]);
  expect(await listSessions()).toEqual([]);
  expect((await getProviderCatalog()).providers).toEqual(
    sessionProviders.map(({ id, name }) => ({ id, name, installed: false })),
  );
  for (const reader of readers) expect(reader).not.toHaveBeenCalled();
});

test("failed discovery leaves provider settings reachable and the next request can retry", async () => {
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "codex");
  const read = spyOn(codexProvider, "listModels")
    .mockRejectedValueOnce(new Error("Please authenticate"))
    .mockResolvedValue([MODEL]);
  expect(await getProviderCatalog()).toMatchObject({
    models: [],
    providers: expect.arrayContaining([{ id: "codex", name: codexProvider.name, installed: true }]),
  });
  expect(await listModels()).toEqual([{ ...MODEL, providerName: codexProvider.name }]);
  expect(read).toHaveBeenCalledTimes(2);
});

test.each(sessionProviders.map((provider) => provider.id))(
  "%s alone supplies the available model catalog",
  async (id) => {
    const available = sessionProviders.find((provider) => provider.id === id)!;
    const unavailableModels = sessionProviders
      .filter((provider) => provider !== available)
      .map((provider) =>
        spyOn(provider, "listModels").mockRejectedValue(new Error("Must not start")),
      );
    spyOn(cli, "isInstalled").mockImplementation((providerId) => providerId === id);
    const model = { id: "same-name", name: "Available model", provider: id };
    spyOn(available, "listModels").mockResolvedValue([model]);
    expect(await listModels()).toEqual([{ ...model, providerName: available.name }]);
    for (const models of unavailableModels) expect(models).not.toHaveBeenCalled();
  },
);

test("an unavailable provider does not suppress the other provider's catalog", async () => {
  spyOn(console, "error").mockImplementation(() => {});
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "copilot" || id === "codex");
  spyOn(copilotProvider, "listModels").mockRejectedValue(new Error("Please authenticate"));
  spyOn(codexProvider, "listModels").mockResolvedValue([
    { id: "model", name: "Model", provider: "codex" },
  ]);
  expect((await listModels()).map((model) => model.provider)).toEqual(["codex"]);
});

test("concurrent discovery is shared and the catalog stays cached for the server lifetime", async () => {
  let now = 1_000_000;
  spyOn(Date, "now").mockImplementation(() => now);
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "codex");
  const discovery = Promise.withResolvers<ModelInfo[]>();
  const read = spyOn(codexProvider, "listModels").mockReturnValue(discovery.promise);
  const first = listModels();
  const concurrent = listModels();
  discovery.resolve([MODEL]);
  const expected = [{ ...MODEL, providerName: codexProvider.name }];
  expect(await Promise.all([first, concurrent])).toEqual([expected, expected]);
  now += 24 * 60 * 60_000;
  expect(await listModels()).toEqual(expected);
  expect(read).toHaveBeenCalledTimes(1);
});

test("overlapping session discovery shares one native read, then discovers fresh histories", async () => {
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "codex");
  const discovery = Promise.withResolvers<Session[]>();
  const read = spyOn(codexProvider, "listSessions").mockReturnValue(discovery.promise);
  const requests = Array.from({ length: 5 }, () => listSessions());
  await Promise.resolve();
  discovery.resolve([SESSION]);
  const expected = [{ ...SESSION, provider: { id: "codex" } }];
  expect(await Promise.all(requests)).toEqual(Array.from({ length: 5 }, () => expected));
  expect(read).toHaveBeenCalledTimes(1);

  const fresh = { ...SESSION, id: "new-native-session" };
  read.mockResolvedValue([fresh]);
  expect(await listSessions()).toEqual([{ ...fresh, provider: { id: "codex" } }]);
  expect(read).toHaveBeenCalledTimes(2);
});

test("failed overlapping session discovery is isolated, logged, and retried", async () => {
  const error = new Error("Please authenticate");
  const log = spyOn(console, "error").mockImplementation(() => {});
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "copilot" || id === "codex");
  const discovery = Promise.withResolvers<Session[]>();
  const copilotRead = spyOn(copilotProvider, "listSessions")
    .mockReturnValueOnce(discovery.promise)
    .mockResolvedValue([{ ...SESSION, id: "copilot-session" }]);
  const codexRead = spyOn(codexProvider, "listSessions").mockResolvedValue([SESSION]);
  const requests = [listSessions(), listSessions()];
  await Promise.resolve();
  discovery.reject(error);
  const expected = [{ ...SESSION, provider: { id: "codex" } }];
  expect(await Promise.all(requests)).toEqual([expected, expected]);
  expect(copilotRead).toHaveBeenCalledTimes(1);
  expect(codexRead).toHaveBeenCalledTimes(1);
  expect(log.mock.calls).toEqual([
    [`Unable to discover ${copilotProvider.name}:`, error],
    [`Unable to discover ${copilotProvider.name}:`, error],
  ]);

  expect(await listSessions()).toEqual([
    { ...SESSION, id: "copilot-session", provider: { id: "copilot" } },
    ...expected,
  ]);
  expect(copilotRead).toHaveBeenCalledTimes(2);
  expect(codexRead).toHaveBeenCalledTimes(2);
});

test("synchronous session discovery failures still leave other providers visible", async () => {
  const error = new Error("Unable to start discovery");
  const log = spyOn(console, "error").mockImplementation(() => {});
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "copilot" || id === "codex");
  spyOn(copilotProvider, "listSessions").mockImplementation(() => {
    throw error;
  });
  spyOn(codexProvider, "listSessions").mockResolvedValue([SESSION]);
  expect(await listSessions()).toEqual([{ ...SESSION, provider: { id: "codex" } }]);
  expect(log).toHaveBeenCalledWith(`Unable to discover ${copilotProvider.name}:`, error);
});

test("enablement and installation gate each request during shared session discovery", async () => {
  const disabledProviders: string[] = [];
  spyOn(workspaceSettings, "getSettings").mockImplementation(async () => ({
    ...DEFAULT_SETTINGS,
    disabledProviders,
  }));
  const installed = spyOn(cli, "isInstalled").mockImplementation((id) => id === "codex");
  const discovery = Promise.withResolvers<Session[]>();
  const read = spyOn(codexProvider, "listSessions").mockReturnValue(discovery.promise);
  const first = listSessions();
  await Promise.resolve();

  disabledProviders.push("codex");
  expect(await listSessions()).toEqual([]);
  disabledProviders.length = 0;
  installed.mockReturnValue(false);
  expect(await listSessions()).toEqual([]);
  installed.mockImplementation((id) => id === "codex");
  const concurrent = listSessions();
  await Promise.resolve();
  discovery.resolve([SESSION]);
  const expected = [{ ...SESSION, provider: { id: "codex" } }];
  expect(await Promise.all([first, concurrent])).toEqual([expected, expected]);
  expect(read).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  "old session discovery cannot evict a pending read after shutdown (fails: %s)",
  async (fails) => {
    spyOn(console, "error").mockImplementation(() => {});
    spyOn(cli, "isInstalled").mockImplementation((id) => id === "codex");
    const old = Promise.withResolvers<Session[]>();
    const current = Promise.withResolvers<Session[]>();
    const read = spyOn(codexProvider, "listSessions")
      .mockReturnValueOnce(old.promise)
      .mockReturnValue(current.promise);
    const first = listSessions();
    await Promise.resolve();
    await stopProviders();
    const next = listSessions();
    await Promise.resolve();

    if (fails) old.reject(new Error("Stopped"));
    else old.resolve([SESSION]);
    expect(await first).toEqual(fails ? [] : [{ ...SESSION, provider: { id: "codex" } }]);
    const concurrent = listSessions();
    await Promise.resolve();
    const fresh = { ...SESSION, id: "fresh-session" };
    current.resolve([fresh]);
    const expected = [{ ...fresh, provider: { id: "codex" } }];
    expect(await Promise.all([next, concurrent])).toEqual([expected, expected]);
    expect(read).toHaveBeenCalledTimes(2);
  },
);

test("enablement gates discovery and toggling reuses each provider's model cache", async () => {
  const disabledProviders = ["claude"];
  spyOn(workspaceSettings, "getSettings").mockImplementation(async () => ({
    ...DEFAULT_SETTINGS,
    disabledProviders,
  }));
  spyOn(cli, "isInstalled").mockReturnValue(true);
  const readers = sessionProviders.map((provider) => ({
    models: spyOn(provider, "listModels").mockResolvedValue([{ ...MODEL, provider: provider.id }]),
    sessions: spyOn(provider, "listSessions").mockResolvedValue([
      {
        id: provider.id,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ]),
  }));
  expect((await listModels()).map(({ provider }) => provider)).toEqual(["copilot", "codex"]);
  expect((await listSessions()).map(({ provider }) => provider?.id)).toEqual(["copilot", "codex"]);
  expect(readers[2]!.models).not.toHaveBeenCalled();
  expect(readers[2]!.sessions).not.toHaveBeenCalled();

  disabledProviders.push("copilot", "codex");
  expect(await listModels()).toEqual([]);
  expect(await listSessions()).toEqual([]);
  disabledProviders.length = 0;
  expect((await listModels()).map(({ provider }) => provider)).toEqual([
    "copilot",
    "codex",
    "claude",
  ]);
  for (const reader of readers) expect(reader.models).toHaveBeenCalledTimes(1);
});

test("provider shutdown clears the model catalog", async () => {
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "codex");
  const read = spyOn(codexProvider, "listModels").mockResolvedValue([MODEL]);
  await listModels();
  await stopProviders();
  await listModels();
  expect(read).toHaveBeenCalledTimes(2);
});

test.each([true, false])(
  "successful update checks refresh only that provider's models (version changed: %s)",
  async (updated) => {
    spyOn(cli, "isInstalled").mockImplementation((id) => id === "copilot" || id === "codex");
    const copilotModels = spyOn(copilotProvider, "listModels").mockResolvedValue([
      { ...MODEL, provider: "copilot" },
    ]);
    const codexModels = spyOn(codexProvider, "listModels")
      .mockResolvedValueOnce([MODEL])
      .mockResolvedValue([{ ...MODEL, id: "new-model" }]);
    await listModels();
    const result = { version: "1.1.0", updated };
    spyOn(cli, "updateProvider").mockResolvedValue(result);
    const stop = spyOn(codexProvider, "stop");
    const events = mock();
    onTestFinished(subscribeWorkspaceEvents(events));

    expect(await updateProvider("codex")).toEqual(result);
    expect(events.mock.calls).toEqual([[{ type: "providers.changed" }]]);
    expect((await listModels()).map(({ id }) => id)).toEqual(["model", "new-model"]);
    expect(copilotModels).toHaveBeenCalledTimes(1);
    expect(codexModels).toHaveBeenCalledTimes(2);
    expect(stop).not.toHaveBeenCalled();
  },
);

test("failed updates retain the cached catalog without notifying clients", async () => {
  spyOn(cli, "isInstalled").mockImplementation((id) => id === "codex");
  const read = spyOn(codexProvider, "listModels").mockResolvedValue([MODEL]);
  const catalog = await listModels();
  spyOn(cli, "updateProvider").mockRejectedValue(new Error("Update failed"));
  const events = mock();
  onTestFinished(subscribeWorkspaceEvents(events));

  await expect(updateProvider("codex")).rejects.toThrow("Update failed");
  expect(await listModels()).toEqual(catalog);
  expect(read).toHaveBeenCalledTimes(1);
  expect(events).not.toHaveBeenCalled();
});
