import type { SessionEvent as SdkSessionEvent } from "@github/copilot-sdk";
import type { SessionEvent } from "@sessions/model";
import type { SessionUsage, TokenUsage } from "@sessions/model/usage";

type UsageData = Extract<SdkSessionEvent, { type: "assistant.usage" }>["data"];
type CheckpointData = Extract<SdkSessionEvent, { type: "session.usage_checkpoint" }>["data"];

// Workaround: CLI 1.0.105 persists usage_record, absent from SDK 1.0.24's types.
// Remove this extension once the SDK declares the durable receipt.
export type CopilotEvent =
  | SdkSessionEvent
  | { type: "session.usage_record"; data: { usage: UsageData }; agentId?: string };

/** Durable receipts are emitted live too; ephemeral assistant.usage would count each call twice. */
export function createCopilotUsageProjector() {
  let watermarks: Record<string, number | undefined> = {};
  return (event: CopilotEvent): SessionEvent[] | undefined => {
    switch (event.type) {
      case "session.usage_record": {
        const usage = event.data.usage;
        const accounting = usage.accounting;
        if (accounting) {
          const previous = watermarks[accounting.sourceSessionId];
          if (previous !== undefined && accounting.sequence <= previous) return [];
          watermarks[accounting.sourceSessionId] = accounting.sequence;
        }
        const amount = usage.copilotUsage?.totalNanoAiu;
        const tokens = tokenUsage(usage);
        return [
          {
            type: "usage",
            mode: "delta",
            usage: {
              aiCredits: toAiCredits(amount ?? 0),
              status: usage.aiCreditsStatus ?? (amount === undefined ? "unavailable" : "complete"),
            },
            ...(tokens ? { tokens } : {}),
          },
        ];
      }
      case "session.usage_checkpoint":
      case "session.shutdown": {
        if (event.agentId) return [];
        const { totalNanoAiu, providerModelMetrics, usageAccountingWatermarks } = event.data;
        if (totalNanoAiu === undefined) return [];
        watermarks = { ...usageAccountingWatermarks };
        return [
          {
            type: "usage",
            mode: "total",
            usage: checkpointUsage(totalNanoAiu, providerModelMetrics),
          },
        ];
      }
      default:
        return undefined;
    }
  };
}

function checkpointUsage(
  amount: number,
  metrics: CheckpointData["providerModelMetrics"],
): SessionUsage {
  const statuses = metrics?.map((metric) => metric.metrics?.aiCreditsStatus) ?? [];
  return {
    aiCredits: toAiCredits(amount),
    status:
      statuses.length > 0 && statuses.every((status) => status === "complete")
        ? "complete"
        : amount > 0 || statuses.some((status) => status === "complete" || status === "partial")
          ? "partial"
          : "unavailable",
  };
}

function tokenUsage({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
}: UsageData): TokenUsage | undefined {
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  )
    return undefined;
  return {
    input: inputTokens ?? 0,
    output: outputTokens ?? 0,
    cacheRead: cacheReadTokens ?? 0,
    cacheWrite: cacheWriteTokens ?? 0,
  };
}

function toAiCredits(nanoAiu: number): number {
  if (!Number.isFinite(nanoAiu) || nanoAiu < 0) {
    throw new Error("Copilot reported an invalid AI credit amount.");
  }
  return nanoAiu / 1e9;
}
