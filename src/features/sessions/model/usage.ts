/** Provider-reported AI credits; a partial value is a subtotal, never an estimate. */
export type SessionUsage = {
  aiCredits: number;
  status: "complete" | "partial" | "unavailable";
};

/** Tokens one model call reported; input includes prompt tokens read from or written to cache. */
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export function sumSessionUsage(usages: readonly (SessionUsage | undefined)[]): SessionUsage {
  const reported = usages.filter(
    (usage): usage is SessionUsage => usage !== undefined && usage.status !== "unavailable",
  );
  return {
    aiCredits: reported.reduce((total, usage) => total + usage.aiCredits, 0),
    status:
      reported.length === 0
        ? "unavailable"
        : usages.every((usage) => usage?.status === "complete")
          ? "complete"
          : "partial",
  };
}
