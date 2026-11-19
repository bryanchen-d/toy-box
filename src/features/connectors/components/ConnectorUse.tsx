// Presentation both kinds of connector share: a connection's state and the counts their use shows.

import { cn } from "@/shared/utils";
import type { ConnectorStatus } from "../model";

export const CONNECTION_STATES = {
  connected: "Connected",
  connecting: "Connecting",
  unreachable: "Unreachable",
} as const satisfies Record<ConnectorStatus["state"], string>;

/** Green while connected, red once unreachable, amber while connecting. */
export function ConnectionDot({ state }: { state: ConnectorStatus["state"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        state === "connected"
          ? "bg-green-500"
          : state === "unreachable"
            ? "bg-destructive"
            : "bg-amber-500",
      )}
    />
  );
}

export function UseTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}
