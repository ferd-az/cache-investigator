import {
  useCallback,
  useMemo,
  useState,
  type KeyboardEvent,
  type PointerEvent
} from "react";
import { Line, LineChart, ReferenceDot, XAxis, YAxis } from "recharts";
import type { MetricName } from "../investigation/contracts";
import type { QueryMetricsResult } from "../telemetry/tools";
import { ChartContainer, type ChartConfig } from "./ui/chart";
import { MetadataSeparator } from "./ui/metadata-separator";

const AXIS_TICK_MINUTES = 15;
const BEFORE_COLOR = "#4c4c54";
const AFTER_COLOR = "var(--accent-vermilion)";

type SignalRow = {
  metric: MetricName;
  label: string;
  unit: string;
  domain: [number, number | "auto"];
  format: (value: number) => string;
};

const SIGNAL_ROWS: SignalRow[] = [
  {
    metric: "cache_hit_rate",
    label: "Cache hit rate",
    unit: "percent",
    domain: [0, 100],
    format: (value) => `${Math.round(value)}%`
  },
  {
    metric: "cache_key_cardinality",
    label: "Cache keys",
    unit: "per minute",
    domain: [0, "auto"],
    format: formatCompact
  },
  {
    metric: "origin_request_count",
    label: "Origin requests",
    unit: "per minute",
    domain: [0, "auto"],
    format: formatCompact
  },
  {
    metric: "response_latency_p99",
    label: "Response p99",
    unit: "milliseconds",
    domain: [0, "auto"],
    format: formatDuration
  }
];

const chartConfig = {
  before: {
    label: "Before",
    color: BEFORE_COLOR
  },
  after: {
    label: "After",
    color: AFTER_COLOR
  }
} satisfies ChartConfig;

const axisTime = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "UTC"
});

const tooltipTime = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC"
});

export type SignalStripChartProps = {
  series: QueryMetricsResult;
  from: string;
  to: string;
  scopeLabel: string;
  onsetAt?: string;
  markers?: readonly { label: string; at: string }[];
  bands?: readonly { label: string; from: string; to: string }[];
};

type Datum = {
  timestamp: number;
  value: number;
  before?: number;
  after?: number;
};

type ChartRowModel = SignalRow & {
  data: Datum[];
  before: number;
  after: number;
};

export function SignalStripChart({
  series,
  from,
  to,
  scopeLabel,
  onsetAt,
  markers = [],
  bands = []
}: SignalStripChartProps) {
  const [activeTimestamp, setActiveTimestamp] = useState<number | null>(null);
  const model = useMemo(
    () => buildChartModel(series, from, to, onsetAt, markers, bands),
    [bands, from, markers, onsetAt, series, to]
  );
  const selectNearestTimestamp = useCallback(
    (timestamp: number) => {
      setActiveTimestamp(nearestValue(model.timestamps, timestamp));
    },
    [model.timestamps]
  );
  const handlePointer = useCallback(
    (event: PointerEvent<HTMLInputElement>) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const progress = clamp((event.clientX - bounds.left) / bounds.width);
      selectNearestTimestamp(
        model.fromMs + progress * (model.toMs - model.fromMs)
      );
    },
    [model.fromMs, model.toMs, selectNearestTimestamp]
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const currentIndex =
        activeTimestamp === null
          ? model.timestamps.length - 1
          : Math.max(0, model.timestamps.indexOf(activeTimestamp));
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? model.timestamps.length - 1
            : event.key === "ArrowLeft"
              ? Math.max(0, currentIndex - 1)
              : Math.min(model.timestamps.length - 1, currentIndex + 1);
      setActiveTimestamp(model.timestamps[nextIndex] ?? null);
    },
    [activeTimestamp, model.timestamps]
  );
  if (model.rows.length === 0) return null;

  return (
    <figure
      className="flex flex-col gap-4"
      aria-labelledby="signal-chart-title"
    >
      <figcaption className="flex flex-col gap-2 px-2 sm:flex-row sm:items-baseline sm:justify-between">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
          <span
            className="font-mono text-xs font-medium text-[#74747c]"
            id="signal-chart-title"
          >
            signals
          </span>
          <span className="flex flex-wrap items-center gap-2 text-xs text-[#8e8e96]">
            <span>{scopeLabel}</span>
            <span className="inline-flex items-center gap-2">
              <MetadataSeparator />
              <span>{series.interval} buckets</span>
            </span>
            <span className="inline-flex items-center gap-2">
              <MetadataSeparator />
              <span>
                {axisTime.format(model.fromMs)}–{axisTime.format(model.toMs)}{" "}
                UTC
              </span>
            </span>
          </span>
        </span>
        {model.bands.length ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#85858d]">
            {model.bands.map((band) => (
              <span
                className="inline-flex items-center gap-1.5"
                key={`${band.label}:${band.from}`}
              >
                <span
                  className="h-2.5 w-3.5 rounded-[3px] bg-[var(--accent-amber-soft)]"
                  aria-hidden="true"
                />
                <span>{band.label}</span>
                <MetadataSeparator />
                <span>
                  {axisTime.format(band.from)}–{axisTime.format(band.to)}
                </span>
              </span>
            ))}
          </span>
        ) : null}
      </figcaption>

      <div className="relative pt-8">
        <TimelineBandLayer
          fromMs={model.fromMs}
          toMs={model.toMs}
          bands={model.bands}
        />
        <div className="relative z-10">
          {model.rows.map((row, index) => (
            <SignalChartRow
              row={row}
              fromMs={model.fromMs}
              toMs={model.toMs}
              isLast={index === model.rows.length - 1}
              key={row.metric}
            />
          ))}
        </div>
        <TimelineRuleLayer
          fromMs={model.fromMs}
          toMs={model.toMs}
          markers={model.markers}
          onsetAt={model.onsetAt}
        />
        <SharedInteractionLayer
          activeTimestamp={activeTimestamp}
          fromMs={model.fromMs}
          toMs={model.toMs}
          rows={model.rows}
          timestamps={model.timestamps}
          onBlur={() => setActiveTimestamp(null)}
          onFocus={() =>
            setActiveTimestamp(
              (current) => current ?? model.timestamps.at(-1) ?? null
            )
          }
          onKeyDown={handleKeyDown}
          onPointerDown={handlePointer}
          onPointerLeave={() => setActiveTimestamp(null)}
          onPointerMove={handlePointer}
          onSelectTimestamp={setActiveTimestamp}
        />
      </div>
    </figure>
  );
}

function SharedInteractionLayer({
  activeTimestamp,
  fromMs,
  toMs,
  rows,
  timestamps,
  onBlur,
  onFocus,
  onKeyDown,
  onPointerDown,
  onPointerLeave,
  onPointerMove,
  onSelectTimestamp
}: {
  activeTimestamp: number | null;
  fromMs: number;
  toMs: number;
  rows: ChartRowModel[];
  timestamps: number[];
  onBlur: () => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLInputElement>) => void;
  onPointerLeave: () => void;
  onPointerMove: (event: PointerEvent<HTMLInputElement>) => void;
  onSelectTimestamp: (timestamp: number | null) => void;
}) {
  const activeRows =
    activeTimestamp === null
      ? []
      : rows.flatMap((row) => {
          const datum = row.data.find(
            (reading) => reading.timestamp === activeTimestamp
          );
          return datum ? [{ row, datum }] : [];
        });
  const position =
    activeTimestamp === null ? 0 : toPercent(activeTimestamp, fromMs, toMs);
  const tooltipOnLeft = position > 62;
  const activeIndex =
    activeTimestamp === null
      ? timestamps.length - 1
      : Math.max(0, timestamps.indexOf(activeTimestamp));

  return (
    <>
      <input
        className="peer absolute inset-y-0 right-3 left-3 z-30 h-auto w-auto cursor-crosshair touch-pan-y appearance-none opacity-0 sm:right-[156px] sm:left-[164px]"
        type="range"
        min={0}
        max={Math.max(0, timestamps.length - 1)}
        step={1}
        value={activeIndex}
        aria-label="Inspect signal values by time"
        aria-valuetext={
          activeTimestamp === null
            ? undefined
            : `${tooltipTime.format(activeTimestamp)} UTC`
        }
        onBlur={onBlur}
        onChange={(event) =>
          onSelectTimestamp(
            timestamps[Number(event.currentTarget.value)] ?? null
          )
        }
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerLeave={onPointerLeave}
        onPointerMove={onPointerMove}
      />
      <span
        className="pointer-events-none absolute inset-y-0 right-3 left-3 z-20 hidden outline-2 outline-offset-2 outline-[#727783] peer-focus-visible:block sm:right-[156px] sm:left-[164px]"
        aria-hidden="true"
      />
      {activeTimestamp !== null ? (
        <div
          className="pointer-events-none absolute inset-y-0 right-3 left-3 z-40 sm:right-[156px] sm:left-[164px]"
          aria-hidden="true"
        >
          <span
            className="absolute inset-y-0 w-px bg-[#5e626c]/45"
            style={{ left: `${position}%` }}
          />
          <div
            className="absolute top-10 w-[218px] rounded-lg bg-white/95 p-3 shadow-[0_14px_38px_rgba(28,28,35,0.14)] backdrop-blur-sm"
            style={{
              left: `${position}%`,
              transform: tooltipOnLeft
                ? "translateX(calc(-100% - 12px))"
                : "translateX(12px)"
            }}
          >
            <div className="flex items-baseline justify-between gap-3 pb-2">
              <span className="font-mono text-[11px] font-medium text-[#33343a] tabular-nums">
                {tooltipTime.format(activeTimestamp)} UTC
              </span>
              <span className="text-[10px] text-[#96969e]">1m bucket</span>
            </div>
            <div className="flex flex-col gap-2 pt-2">
              {activeRows.map(({ row, datum }) => (
                <div
                  className="flex items-baseline justify-between gap-4"
                  key={row.metric}
                >
                  <span className="text-[11px] text-[#777780]">
                    {row.label}
                  </span>
                  <span className="font-mono text-xs font-medium text-[#29292f] tabular-nums">
                    {row.format(datum.value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function TimelineBandLayer({
  fromMs,
  toMs,
  bands
}: {
  fromMs: number;
  toMs: number;
  bands: Array<{ label: string; from: number; to: number }>;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-3 left-3 z-0 sm:right-[156px] sm:left-[164px]"
      aria-hidden="true"
    >
      {bands.map((band) => (
        <div
          className="absolute inset-y-0 bg-[var(--accent-amber-soft)]/85"
          style={{
            left: `${toPercent(band.from, fromMs, toMs)}%`,
            width: `${toPercent(band.to, fromMs, toMs) - toPercent(band.from, fromMs, toMs)}%`
          }}
          key={`${band.label}:${band.from}`}
        />
      ))}
    </div>
  );
}

function TimelineRuleLayer({
  fromMs,
  toMs,
  markers,
  onsetAt
}: {
  fromMs: number;
  toMs: number;
  markers: Array<{ label: string; at: number }>;
  onsetAt?: number;
}) {
  return (
    <div
      className="pointer-events-none absolute inset-y-0 right-3 left-3 z-20 sm:right-[156px] sm:left-[164px]"
      aria-hidden="true"
    >
      {markers.map((marker) => (
        <div
          className="absolute inset-y-0 w-px bg-[repeating-linear-gradient(to_bottom,color-mix(in_oklab,var(--accent-cobalt)_42%,transparent)_0_2px,transparent_2px_7px)]"
          style={{ left: `${toPercent(marker.at, fromMs, toMs)}%` }}
          key={`${marker.label}:${marker.at}`}
        >
          <span className="absolute top-1 right-1.5 whitespace-nowrap font-mono text-[10px] font-medium text-[var(--accent-cobalt-ink)]">
            <span className="sm:hidden">
              deploy · {axisTime.format(marker.at)}
            </span>
            <span className="hidden sm:inline">
              deploy {compactMarkerLabel(marker.label)} ·{" "}
              {axisTime.format(marker.at)}
            </span>
          </span>
        </div>
      ))}
      {onsetAt !== undefined ? (
        <div
          className="absolute inset-y-0 border-l border-[var(--accent-vermilion)]"
          style={{ left: `${toPercent(onsetAt, fromMs, toMs)}%` }}
        >
          <span className="absolute top-1 left-1.5 whitespace-nowrap font-mono text-[10px] font-medium text-[var(--accent-vermilion-ink)]">
            onset · {axisTime.format(onsetAt)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function SignalChartRow({
  row,
  fromMs,
  toMs,
  isLast
}: {
  row: ChartRowModel;
  fromMs: number;
  toMs: number;
  isLast: boolean;
}) {
  const lastDatum = row.data.at(-1);
  const endpointColor =
    lastDatum?.after === undefined ? BEFORE_COLOR : AFTER_COLOR;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-3 sm:grid-cols-[136px_minmax(0,1fr)_128px] sm:px-4">
      <span className="col-start-1 row-start-1 flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-xs font-medium tracking-[-0.01em] text-[#4c4c54]">
          {row.label}
        </span>
        <span className="truncate font-mono text-[10px] text-[#9999a1]">
          {row.unit}
        </span>
      </span>
      <span className="sr-only">
        {row.label}: {row.format(row.before)} before the deployment,{" "}
        {row.format(row.after)} after.
      </span>

      <ChartContainer
        className="col-span-2 col-start-1 row-start-2 h-16 w-full min-w-0 aspect-auto sm:col-span-1 sm:col-start-2 sm:row-start-1"
        config={chartConfig}
        initialDimension={{ width: 700, height: 64 }}
      >
        <LineChart
          accessibilityLayer
          data={row.data}
          margin={{ top: 7, right: 2, bottom: 7, left: 2 }}
        >
          <XAxis
            dataKey="timestamp"
            type="number"
            domain={[fromMs, toMs]}
            hide
          />
          <YAxis domain={row.domain} hide />

          <Line
            activeDot={false}
            connectNulls={false}
            dataKey="before"
            dot={false}
            isAnimationActive={false}
            stroke={BEFORE_COLOR}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            type="linear"
          />
          <Line
            activeDot={false}
            connectNulls={false}
            dataKey="after"
            dot={false}
            isAnimationActive={false}
            stroke={AFTER_COLOR}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.8}
            type="linear"
          />
          {lastDatum ? (
            <ReferenceDot
              fill={endpointColor}
              r={2.75}
              stroke="#ffffff"
              strokeWidth={1.5}
              x={lastDatum.timestamp}
              y={lastDatum.value}
            />
          ) : null}
        </LineChart>
      </ChartContainer>

      <span className="col-start-2 row-start-1 flex items-baseline justify-end gap-2 font-mono tabular-nums sm:col-start-3">
        <span className="text-[11px] text-[#96969e]">
          {row.format(row.before)}
        </span>
        <span className="text-[10px] text-[#c1c1c7]" aria-hidden="true">
          →
        </span>
        <span className="text-[13px] font-semibold tracking-[-0.01em] text-[var(--accent-vermilion-ink)]">
          {row.format(row.after)}
        </span>
      </span>

      {isLast ? (
        <div
          className="relative col-span-2 col-start-1 row-start-3 h-4 sm:col-span-1 sm:col-start-2 sm:row-start-2"
          aria-hidden="true"
        >
          {axisTicks(fromMs, toMs).map((tick) => (
            <span
              className="absolute top-0 -translate-x-1/2 font-mono text-[10px] text-[#a0a0a8] tabular-nums first:translate-x-0 last:-translate-x-full"
              style={{
                left: `${((tick - fromMs) / (toMs - fromMs)) * 100}%`
              }}
              key={tick}
            >
              {axisTime.format(tick)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function buildChartModel(
  series: QueryMetricsResult,
  from: string,
  to: string,
  onsetAt: string | undefined,
  markers: readonly { label: string; at: string }[],
  bands: readonly { label: string; from: string; to: string }[]
) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const visibleMarkers = markers
    .map((marker) => ({ ...marker, at: Date.parse(marker.at) }))
    .filter((marker) => marker.at >= fromMs && marker.at < toMs);
  const visibleBands = bands
    .map((band) => ({
      ...band,
      from: Math.max(fromMs, Date.parse(band.from)),
      to: Math.min(toMs, Date.parse(band.to))
    }))
    .filter((band) => band.from < band.to);
  const parsedOnsetAt = onsetAt ? Date.parse(onsetAt) : undefined;
  const visibleOnsetAt =
    parsedOnsetAt !== undefined &&
    parsedOnsetAt >= fromMs &&
    parsedOnsetAt < toMs
      ? parsedOnsetAt
      : undefined;
  const splitAt =
    visibleOnsetAt ??
    (visibleMarkers.length
      ? Math.min(...visibleMarkers.map((marker) => marker.at))
      : undefined);
  const afterAt = visibleOnsetAt ?? splitAt;
  const points = series.points
    .map((point) => ({
      timestamp: Date.parse(point.bucketStart),
      values: point.values
    }))
    .filter((point) => point.timestamp >= fromMs && point.timestamp < toMs)
    .sort((left, right) => left.timestamp - right.timestamp);

  const rows = SIGNAL_ROWS.flatMap((row) => {
    const readings = points.flatMap((point) => {
      const value = point.values[row.metric];
      return typeof value === "number"
        ? [{ timestamp: point.timestamp, value }]
        : [];
    });
    if (readings.length < 2) return [];

    return [
      {
        ...row,
        data: readings.map((reading) => ({
          timestamp: reading.timestamp,
          value: reading.value,
          ...(splitAt === undefined || reading.timestamp <= splitAt
            ? { before: reading.value }
            : {}),
          ...(splitAt !== undefined && reading.timestamp >= splitAt
            ? { after: reading.value }
            : {})
        })),
        before: median(
          readings
            .filter(
              (reading) => splitAt === undefined || reading.timestamp < splitAt
            )
            .map((reading) => reading.value)
        ),
        after: median(
          readings
            .filter(
              (reading) => afterAt === undefined || reading.timestamp >= afterAt
            )
            .map((reading) => reading.value)
        )
      }
    ];
  });

  return {
    fromMs,
    toMs,
    markers: visibleMarkers,
    bands: visibleBands,
    onsetAt: visibleOnsetAt,
    timestamps: points.map((point) => point.timestamp),
    rows
  };
}

function clamp(value: number) {
  return Math.min(1, Math.max(0, value));
}

function nearestValue(values: number[], target: number) {
  if (values.length === 0) return null;
  let nearest = values[0];
  let distance = Math.abs(nearest - target);
  for (const value of values.slice(1)) {
    const nextDistance = Math.abs(value - target);
    if (nextDistance >= distance) continue;
    nearest = value;
    distance = nextDistance;
  }
  return nearest;
}

function toPercent(value: number, fromMs: number, toMs: number) {
  return ((value - fromMs) / (toMs - fromMs)) * 100;
}

function compactMarkerLabel(label: string) {
  return label.match(/\bv\d+\b/i)?.[0] ?? label;
}

function axisTicks(fromMs: number, toMs: number) {
  const step = AXIS_TICK_MINUTES * 60_000;
  const ticks: number[] = [];
  for (let tick = fromMs; tick <= toMs; tick += step) ticks.push(tick);
  return ticks;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatCompact(value: number) {
  return value >= 1000
    ? `${(value / 1000).toFixed(1)}k`
    : `${Math.round(value)}`;
}

function formatDuration(value: number) {
  return value >= 1000
    ? `${(value / 1000).toFixed(2)}s`
    : `${Math.round(value)}ms`;
}
