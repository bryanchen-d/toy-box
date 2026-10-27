import { homedir } from "node:os";
import { approveAll } from "@github/copilot-sdk";
import type {
  CopilotSession,
  CopilotClient,
  SessionConfig,
  SessionContext,
  Tool as CopilotTool,
} from "@github/copilot-sdk";
import type { SessionEvent } from "@sessions/model";
import type { ProviderSubscription } from "@providers/model";
import type { SessionConfiguration, SessionProvider } from "@providers/server/provider";
import { normalizeToolResult } from "@sessions/server/tools/definition";
import { startCopilotClient, stopCopilotClient } from "./client";
import { connectCopilotSession } from "./connection";
import { toModelInfo } from "./models";
import { toSdkSessionModelOptions } from "./modelConfiguration";
import { toSessionSkills } from "./skills";
import { createSdkEventProjector } from "./projector";
import { computerUseServers } from "./computerUse";
import { saveGeneratedImages } from "./generatedImages";

export const copilotProvider: SessionProvider = {
  id: "copilot",
  name: "GitHub Copilot",
  async listModels() {
    return (await (await startCopilotClient()).listModels()).map(toModelInfo);
  },
  async readSubscription() {
    const { rpc } = await startCopilotClient();
    const { authInfo } = await rpc.account.getCurrentAuth();
    const plan =
      authInfo && "copilotUser" in authInfo ? authInfo.copilotUser?.copilot_plan : undefined;
    return plan ? toSubscription(plan, (await rpc.account.getQuota({})).quotaSnapshots) : undefined;
  },
  async listSessions() {
    return (await (await startCopilotClient()).listSessions()).map(
      ({ sessionId, startTime, modifiedTime, summary, context }) => ({
        id: sessionId,
        createdAt: startTime,
        updatedAt: modifiedTime,
        title: summary,
        context: {
          directory: sessionDirectory(context),
          gitRoot: context?.gitRoot,
          repository: context?.repository,
          branch: context?.branch,
        },
      }),
    );
  },
  async readHistory({ id, provider }) {
    const nativeId = provider?.sessionId ?? id;
    const client = await startCopilotClient();
    const project = createSdkEventProjector(id);
    const events: SessionEvent[] = [];
    let cursor: string | undefined;
    let hasMore: boolean;
    do {
      const page = await client.rpc.sessions.readPersistedEvents({
        sessionId: nativeId,
        direction: "forward",
        max: 1000,
        cursor,
      });
      events.push(...page.events.flatMap(project));
      cursor = page.cursor;
      hasMore = page.hasMore;
    } while (hasMore);
    return events;
  },
  async listSkills(cwd, skillDirectories) {
    const { skills } = await (
      await startCopilotClient()
    ).rpc.skills.discover({
      ...(cwd ? { projectPaths: [cwd] } : {}),
      skillDirectories: [...skillDirectories],
    });
    return toSessionSkills(skills);
  },
  async create(sessionId, configuration) {
    const client = await startCopilotClient();
    const session = await client.createSession({
      ...(await nativeConfiguration(sessionId, configuration, client)),
      sessionId,
    });
    try {
      const connection = await connect(
        session,
        sessionId,
        configuration.allowUserQuestions,
        configuration.model,
      );
      if (configuration.name) await connection.rename(configuration.name);
      return connection;
    } catch (error) {
      await client.deleteSession(session.sessionId).catch(console.error);
      throw error;
    }
  },
  async resume(session, configuration) {
    const client = await startCopilotClient();
    const native = await client.resumeSession(
      session.provider?.sessionId ?? session.id,
      await nativeConfiguration(session.id, configuration, client),
    );
    return connect(native, session.id, configuration.allowUserQuestions, configuration.model);
  },
  async readDirectory(nativeId) {
    return sessionDirectory(
      (await (await startCopilotClient()).getSessionMetadata(nativeId))?.context,
    );
  },
  async isHistoryCurrent(nativeId, capturedAt) {
    const metadata = await (await startCopilotClient()).getSessionMetadata(nativeId);
    // Preserve the SDK's short trailing-flush window after a completed turn.
    return !!metadata && metadata.modifiedTime.getTime() <= capturedAt + 2_000;
  },
  async delete(nativeId) {
    await (await startCopilotClient()).deleteSession(nativeId);
  },
  stop: stopCopilotClient,
};

type CopilotQuotas = Awaited<
  ReturnType<CopilotClient["rpc"]["account"]["getQuota"]>
>["quotaSnapshots"];

/** Copilot meters premium requests monthly, unless the plan makes them unlimited. */
export function toSubscription(plan: string, quotas: CopilotQuotas): ProviderSubscription {
  const premium = quotas.premium_interactions;
  return {
    plan,
    limits:
      premium && !premium.isUnlimitedEntitlement
        ? [
            {
              name: "Premium requests",
              usedPercent: 100 - premium.remainingPercentage,
              ...(premium.resetDate ? { resetsAt: Date.parse(premium.resetDate) } : {}),
            },
          ]
        : [],
  };
}

async function connect(
  session: CopilotSession,
  sessionId: string,
  allowUserQuestions: boolean,
  appliedModel?: SessionConfiguration["model"],
) {
  if (allowUserQuestions)
    await session.rpc.eventLog.registerInterest({ eventType: "user_input.requested" });
  return connectCopilotSession(session, sessionId, appliedModel);
}

async function nativeConfiguration(
  sessionId: string,
  configuration: SessionConfiguration,
  client: CopilotClient,
): Promise<SessionConfig> {
  const tools: CopilotTool<any>[] = configuration.tools.map((tool) => ({
    ...tool,
    defer: tool.alwaysAvailable ? "never" : undefined,
    skipPermission: true,
    handler: async (args, invocation) => {
      const result = normalizeToolResult(
        await tool.handler(tool.parameters ? tool.parameters.parse(args) : args, {
          ...invocation,
          sessionId,
        }),
      );
      return {
        textResultForLlm: result.content
          .flatMap((item) => (item.type === "text" ? [item.text] : []))
          .join("\n"),
        binaryResultsForLlm: result.content.flatMap((item) =>
          item.type === "image" ? [{ ...item, type: "image" as const }] : [],
        ),
        resultType: result.isError ? ("failure" as const) : ("success" as const),
      };
    },
  }));
  return {
    streaming: true,
    requestCanvasRenderer: true,
    ...toSdkSessionModelOptions(configuration.model),
    workingDirectory: configuration.directory,
    enableConfigDiscovery: true,
    mcpServers: await computerUseServers(client),
    imageGeneration: { enabled: true },
    hooks: { onPostToolUse: saveGeneratedImages },
    enableSkills: true,
    skillDirectories: configuration.skillDirectories,
    systemMessage: { mode: "append", content: configuration.instructions },
    onPermissionRequest: approveAll,
    tools,
    ...(configuration.disableMemory ? { memory: { enabled: false } } : {}),
  };
}

/** The SDK's implicit home directory is not a user-selected workspace. */
function sessionDirectory(context?: SessionContext): string | undefined {
  if (!context?.workingDirectory) return undefined;
  return context.workingDirectory === homedir() && !context.gitRoot && !context.repository
    ? undefined
    : context.workingDirectory;
}
