import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  aggregate,
  AGGREGATIONS,
  PERFORMANCE_BUCKETS,
  USER_AUTHOR,
  type AgentPerformance,
  type Aggregation,
  type PerformanceBucket,
  type PerformancePoint,
  type TeamAddress,
  type TeamPerformance,
} from "@teams/model/performance";
import { teamQueries } from "@teams/queries";
import { AgentAvatar } from "@teams/components/agents/AgentAvatar";
import { Button } from "@/shared/ui/button";
import { SortableTable, type SortableColumn } from "@/shared/ui/sortable-table";
import { cn } from "@/shared/utils";
import { useTeamPane } from "./TeamPaneContext";

const STEERED_TITLE =
  "Wakes that interrupted the agent's running turn with the prompt, rather than starting a turn or waiting for it to end.";

/** What a count chart stacks per agent in one bucket. */
const COUNT_METRICS = {
  messages: { label: "Messages", value: (point, id) => point.messages[id] ?? 0 },
  wakes: { label: "Notifications", value: (point, id) => point.wakes[id] ?? 0 },
  steered: { label: "Steered", value: (point, id) => point.deliveries[id]?.steered ?? 0 },
  queued: { label: "Queued", value: (point, id) => point.deliveries[id]?.queued ?? 0 },
  started: { label: "Woke idle", value: (point, id) => point.deliveries[id]?.started ?? 0 },
  credits: { label: "AI credits", value: (point, id) => point.runtime[id]?.aiCredits ?? 0 },
  busy: { label: "Busy hours", value: (point, id) => (point.runtime[id]?.busyMs ?? 0) / 3_600_000 },
  tokens: {
    label: "Tokens",
    value: (point, id) =>
      (point.runtime[id]?.inputTokens ?? 0) + (point.runtime[id]?.outputTokens ?? 0),
  },
} satisfies Record<
  string,
  { label: string; value: (point: PerformancePoint, agentId: string) => number }
>;
type Metric = keyof typeof COUNT_METRICS | "latency";

const METRIC_LABELS: Record<Metric, string> = {
  ...Object.fromEntries(Object.entries(COUNT_METRICS).map(([key, { label }]) => [key, label])),
  latency: "Reply time",
} as Record<Metric, string>;

const BUCKET_LABELS: Record<PerformanceBucket, string> = {
  hour: "24 hours",
  day: "14 days",
  week: "12 weeks",
};

const AGGREGATION_LABELS: Record<Aggregation, string> = {
  p50: "P50",
  p90: "P90",
  mean: "Mean",
  max: "Max",
};

const PALETTE = ["#0891b2", "#7c3aed", "#db2777", "#ea580c", "#16a34a", "#ca8a04", "#2563eb"];

/** Measured activity over time: a chosen metric charted per agent, and sortable breakdowns. */
export function TeamStats({ teamId, isVisible }: { teamId: string; isVisible: boolean }) {
  const [bucket, setBucket] = useState<PerformanceBucket>("hour");
  const [metric, setMetric] = useState<Metric>("messages");
  const [aggregation, setAggregation] = useState<Aggregation>("p50");
  const { data, error, isPending } = useQuery({
    ...teamQueries.performance(teamId, bucket),
    enabled: isVisible,
  });

  return (
    <div className="space-y-5 p-4 text-xs">
      <div className="space-y-2">
        <ChoiceGroup
          label="Period"
          value={bucket}
          options={PERFORMANCE_BUCKETS.map((value) => [value, BUCKET_LABELS[value]])}
          onChange={setBucket}
        />
        <ChoiceGroup
          label="Chart"
          value={metric}
          options={Object.entries(METRIC_LABELS) as [Metric, string][]}
          onChange={setMetric}
        />
        <ChoiceGroup
          label="Aggregation"
          value={aggregation}
          options={AGGREGATIONS.map((value) => [value, AGGREGATION_LABELS[value]])}
          onChange={setAggregation}
        />
      </div>
      {error ? (
        <p role="alert" className="text-destructive">
          Unable to load performance: {error.message}
        </p>
      ) : isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <StatsContent data={data} metric={metric} aggregation={aggregation} />
      )}
    </div>
  );
}

function StatsContent({
  data,
  metric,
  aggregation,
}: {
  data: TeamPerformance;
  metric: Metric;
  aggregation: Aggregation;
}) {
  const { agent } = useTeamPane();
  const colors = new Map(
    data.agents.map(({ agentId }, index) => [
      agentId,
      agent(agentId).avatar?.color ?? PALETTE[index % PALETTE.length]!,
    ]),
  );
  const sum = (pick: (entry: AgentPerformance) => number) =>
    data.agents.reduce((total, entry) => total + pick(entry), 0);
  const steered = sum(({ deliveries }) => deliveries.steered);
  const delivered = sum(
    ({ deliveries }) => deliveries.started + deliveries.steered + deliveries.queued,
  );
  const replies = aggregate(
    data.series.flatMap(({ responses }) => Object.values(responses).flat()),
    aggregation,
  );
  const aggregationLabel = AGGREGATION_LABELS[aggregation];

  return (
    <>
      <dl className="grid grid-cols-2 gap-2 @lg:grid-cols-3 @3xl:grid-cols-6">
        <Tile label="Agent messages" value={formatCount(sum(({ messages }) => messages))} />
        <Tile label="Notifications" value={formatCount(sum(({ wakes }) => wakes))} />
        <Tile
          label="Steered"
          title={STEERED_TITLE}
          value={
            delivered > 0
              ? `${formatCount(steered)} (${Math.round((steered / delivered) * 100)}%)`
              : "—"
          }
        />
        <Tile
          label={`Reply time ${aggregationLabel}`}
          value={replies === null ? "—" : formatDuration(replies)}
        />
        <Tile label="AI credits" value={formatCredits(sum(({ runtime }) => runtime.aiCredits))} />
        <Tile label="Busy time" value={formatDuration(sum(({ runtime }) => runtime.busyMs))} />
      </dl>
      <section aria-label={`${METRIC_LABELS[metric]} over time`} className="space-y-2">
        <h3 className="font-medium">
          {metric === "latency"
            ? `Reply time (${aggregationLabel}) by when the agent was woken`
            : `${METRIC_LABELS[metric]} over time`}
        </h3>
        {metric === "latency" ? (
          <LatencyChart data={data} aggregation={aggregation} colors={colors} />
        ) : (
          <CountChart data={data} metric={metric} colors={colors} />
        )}
        <ul aria-label="Legend" className="flex flex-wrap gap-x-3 gap-y-1">
          {data.agents.map(({ agentId }) => (
            <li key={agentId} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 rounded-sm"
                style={{ backgroundColor: colors.get(agentId) }}
              />
              {agent(agentId).name}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label="Agents" className="space-y-2">
        <h3 className="font-medium">Agents</h3>
        <AgentsTable agents={data.agents} />
      </section>
      <section aria-label="Who addresses whom" className="space-y-2">
        <h3 className="font-medium">Who addresses whom</h3>
        {data.addresses.length === 0 ? (
          <p className="text-muted-foreground italic">No routed messages in this period.</p>
        ) : (
          <AddressesTable addresses={data.addresses} />
        )}
      </section>
    </>
  );
}

function AgentsTable({ agents }: { agents: readonly AgentPerformance[] }) {
  const { agent } = useTeamPane();
  const active = agents.filter(
    (entry) =>
      entry.messages + entry.wakes + entry.runtime.turns > 0 ||
      entry.deliveries.started + entry.deliveries.steered + entry.deliveries.queued > 0,
  );
  if (active.length === 0) {
    return <p className="text-muted-foreground italic">No activity in this period.</p>;
  }
  const columns: SortableColumn<AgentPerformance>[] = [
    {
      key: "agent",
      label: "Agent",
      sortValue: ({ agentId }) => agent(agentId).name,
      render: ({ agentId }) => <AgentName id={agentId} />,
    },
    { key: "messages", label: "Messages", numeric: true, sortValue: (row) => row.messages },
    {
      key: "wakes",
      label: "Notified",
      title: "Messages that routed to the agent and woke it.",
      numeric: true,
      sortValue: (row) => row.wakes,
    },
    ...deliveryColumns<AgentPerformance>(),
    {
      key: "answered",
      label: "Answered",
      title: "Wakes the agent followed with a public message.",
      numeric: true,
      sortValue: (row) => row.answered,
    },
    ...replyColumns<AgentPerformance>(),
    {
      key: "credits",
      label: "AI credits",
      numeric: true,
      sortValue: (row) => row.runtime.aiCredits,
      render: (row) => formatCredits(row.runtime.aiCredits),
    },
    {
      key: "busy",
      label: "Busy",
      numeric: true,
      sortValue: (row) => row.runtime.busyMs,
      render: (row) => formatDuration(row.runtime.busyMs),
    },
    { key: "turns", label: "Turns", numeric: true, sortValue: (row) => row.runtime.turns },
  ];
  return (
    <SortableTable
      label="Agent performance"
      columns={columns}
      rows={active}
      rowKey={({ agentId }) => agentId}
      initialSort={{ key: "wakes", descending: true }}
    />
  );
}

function AddressesTable({ addresses }: { addresses: readonly TeamAddress[] }) {
  const { agent } = useTeamPane();
  const name = (id: string) => (id === USER_AUTHOR ? "You" : agent(id).name);
  const columns: SortableColumn<TeamAddress>[] = [
    {
      key: "from",
      label: "Sender",
      sortValue: ({ from }) => name(from),
      render: ({ from }) => (from === USER_AUTHOR ? "You" : <AgentName id={from} />),
    },
    {
      key: "to",
      label: "Receiver",
      sortValue: ({ to }) => name(to),
      render: ({ to }) => <AgentName id={to} />,
    },
    {
      key: "count",
      label: "Messages",
      title: "Messages from the sender that routed to the receiver and woke it.",
      numeric: true,
      sortValue: (row) => row.count,
    },
    ...deliveryColumns<TeamAddress>(),
    ...replyColumns<TeamAddress>(),
  ];
  return (
    <SortableTable
      label="Messages between agents"
      columns={columns}
      rows={addresses}
      rowKey={({ from, to }) => `${from}:${to}`}
      initialSort={{ key: "count", descending: true }}
    />
  );
}

function deliveryColumns<
  Row extends { deliveries: AgentPerformance["deliveries"] },
>(): SortableColumn<Row>[] {
  const share = ({ deliveries: { started, steered, queued } }: Row) => {
    const total = started + steered + queued;
    return total > 0 ? steered / total : null;
  };
  return [
    {
      key: "started",
      label: "Woke idle",
      title: "Wakes that started a turn while the agent was idle.",
      numeric: true,
      sortValue: (row) => row.deliveries.started,
    },
    {
      key: "steered",
      label: "Steered",
      title: STEERED_TITLE,
      numeric: true,
      sortValue: (row) => row.deliveries.steered,
    },
    {
      key: "steeredShare",
      label: "Steered %",
      title: "The share of recorded wakes that interrupted a running turn.",
      numeric: true,
      sortValue: share,
      render: (row) => {
        const value = share(row);
        return value === null ? "—" : `${Math.round(value * 100)}%`;
      },
    },
    {
      key: "queued",
      label: "Queued",
      title: "Wakes that waited for the agent's turn to end.",
      numeric: true,
      sortValue: (row) => row.deliveries.queued,
    },
  ];
}

function replyColumns<
  Row extends { medianResponseMs: number | null; p90ResponseMs: number | null },
>(): SortableColumn<Row>[] {
  return [
    {
      key: "p50",
      label: "P50 reply",
      title: "Median time from a wake to the agent's next public message.",
      numeric: true,
      sortValue: (row) => row.medianResponseMs,
      render: (row) => (row.medianResponseMs === null ? "—" : formatDuration(row.medianResponseMs)),
    },
    {
      key: "p90",
      label: "P90 reply",
      numeric: true,
      sortValue: (row) => row.p90ResponseMs,
      render: (row) => (row.p90ResponseMs === null ? "—" : formatDuration(row.p90ResponseMs)),
    },
  ];
}

function AgentName({ id }: { id: string }) {
  const identity = useTeamPane().agent(id);
  return (
    <span className="flex items-center gap-2">
      <AgentAvatar agent={identity} className="size-5" />
      <span className={cn("truncate", identity.deleted && "italic")}>{identity.name}</span>
    </span>
  );
}

const CHART_WIDTH = 10;
const CHART_HEIGHT = 100;

/** Stacked bars per bucket, one segment per agent. */
function CountChart({
  data,
  metric,
  colors,
}: {
  data: TeamPerformance;
  metric: keyof typeof COUNT_METRICS;
  colors: ReadonlyMap<string, string>;
}) {
  const { value, label } = COUNT_METRICS[metric];
  const stacks = data.series.map((point) =>
    data.agents.map(({ agentId }) => ({ agentId, value: value(point, agentId) })),
  );
  const max = Math.max(...stacks.map((stack) => stack.reduce((sum, { value }) => sum + value, 0)));
  const scale = max > 0 ? (CHART_HEIGHT - 2) / max : 0;
  const format = (amount: number) => formatValue(metric, amount);

  return (
    <ChartFrame
      data={data}
      label={`${label} per ${data.bucket}, peaking at ${format(max)}`}
      peak={format(max)}
    >
      {stacks.map((stack, index) => {
        let top = CHART_HEIGHT;
        return stack.map(({ agentId, value }) => {
          const height = value * scale;
          top -= height;
          return height > 0 ? (
            <rect
              key={`${index}:${agentId}`}
              x={index * CHART_WIDTH + 1}
              y={top}
              width={CHART_WIDTH - 2}
              height={height}
              fill={colors.get(agentId)}
            >
              <title>{`${formatBucket(data.series[index]!.start, data.bucket)}: ${format(value)}`}</title>
            </rect>
          ) : null;
        });
      })}
    </ChartFrame>
  );
}

/** One line per agent through the buckets where it was woken and replied. */
function LatencyChart({
  data,
  aggregation,
  colors,
}: {
  data: TeamPerformance;
  aggregation: Aggregation;
  colors: ReadonlyMap<string, string>;
}) {
  const lines = data.agents.map(({ agentId }) => ({
    agentId,
    values: data.series.map((point) => aggregate(point.responses[agentId] ?? [], aggregation)),
  }));
  const max = Math.max(0, ...lines.flatMap(({ values }) => values.map((value) => value ?? 0)));
  const y = (value: number) =>
    CHART_HEIGHT - 2 - (max > 0 ? (value / max) * (CHART_HEIGHT - 4) : 0);
  const x = (index: number) => index * CHART_WIDTH + CHART_WIDTH / 2;
  const peak = max > 0 ? formatDuration(max) : "—";

  return (
    <ChartFrame
      data={data}
      label={`Reply time ${AGGREGATION_LABELS[aggregation]} per ${data.bucket}, peaking at ${peak}`}
      peak={peak}
    >
      {lines.map(({ agentId, values }) => {
        const points = values.flatMap((value, index) => (value === null ? [] : [{ index, value }]));
        return (
          <g key={agentId} stroke={colors.get(agentId)} fill={colors.get(agentId)}>
            {points.length > 1 && (
              <polyline
                fill="none"
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
                points={points.map(({ index, value }) => `${x(index)},${y(value)}`).join(" ")}
              />
            )}
            {points.map(({ index, value }) => (
              <rect key={index} x={x(index) - 1} y={y(value) - 1} width={2} height={2}>
                <title>{`${formatBucket(data.series[index]!.start, data.bucket)}: ${formatDuration(value)}`}</title>
              </rect>
            ))}
          </g>
        );
      })}
    </ChartFrame>
  );
}

function ChartFrame({
  data,
  label,
  peak,
  children,
}: {
  data: TeamPerformance;
  label: string;
  peak: string;
  children: ReactNode;
}) {
  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${data.series.length * CHART_WIDTH} ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
        className="h-32 w-full rounded-md border bg-background"
      >
        {children}
      </svg>
      <figcaption className="flex justify-between text-2xs text-muted-foreground">
        <span>{formatBucket(data.series[0]!.start, data.bucket)}</span>
        <span>Peak {peak}</span>
        <span>{formatBucket(data.series.at(-1)!.start, data.bucket)}</span>
      </figcaption>
    </figure>
  );
}

function ChoiceGroup<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: readonly (readonly [Value, string])[];
  onChange: (value: Value) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      {options.map(([option, text]) => (
        <Button
          key={option}
          type="button"
          size="xs"
          variant={value === option ? "secondary" : "ghost"}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {text}
        </Button>
      ))}
    </div>
  );
}

function Tile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="rounded-md border bg-background px-3 py-2" title={title}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-base font-medium tabular-nums">{value}</dd>
    </div>
  );
}

const COUNT_FORMAT = new Intl.NumberFormat(undefined, { notation: "compact" });
const CREDIT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

function formatCount(value: number): string {
  return COUNT_FORMAT.format(value);
}

function formatCredits(value: number): string {
  return value > 0 && value < 0.01 ? "<0.01" : CREDIT_FORMAT.format(value);
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatValue(metric: keyof typeof COUNT_METRICS, value: number): string {
  if (metric === "credits") return formatCredits(value);
  if (metric === "busy") return `${value.toFixed(1)}h`;
  return formatCount(value);
}

function formatBucket(start: string, bucket: PerformanceBucket): string {
  const date = new Date(start);
  return bucket === "hour"
    ? date.toLocaleTimeString(undefined, { hour: "numeric" })
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
