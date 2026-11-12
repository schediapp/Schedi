"use client";

import { Bar, BarChart, CartesianGrid, ReferenceLine, XAxis, YAxis } from "recharts";

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export type ReportChartPoint = {
  label: string;
  value: number;
  display: string;
};

export type ReportChartPayload = {
  title: string;
  label: string;
  format: "money" | "count";
  average: number | null;
  points: ReportChartPoint[];
};

const COLORS = {
  Bookings: "var(--chart-1)",
  Revenue: "var(--chart-2)",
  Visits: "var(--chart-3)",
} as const;

function axisCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return String(Math.round(value));
}

function axisMoney(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  const abs = Math.abs(value);
  if (abs >= 1000) {
    const compact = Math.round((value / 1000) * 10) / 10;
    return "$" + compact + "k";
  }
  if (Math.abs(value - Math.round(value)) < 0.001) return "$" + Math.round(value);
  return "$" + (Math.round(value * 100) / 100).toFixed(2);
}

function captionFor(payload: ReportChartPayload): string {
  const points = payload.points
    .map((point) => point.label + " " + point.display)
    .join(", ");
  const average =
    payload.average != null && Number.isFinite(payload.average)
      ? " Average " + (payload.format === "money" ? axisMoney(payload.average) : axisCount(payload.average)) + "."
      : "";
  return (payload.title || payload.label) + ". " + points + "." + average;
}

export function ReportChart({ payload }: { payload: ReportChartPayload }) {
  const label = payload.label || "Value";
  const color = COLORS[label as keyof typeof COLORS] || "var(--chart-1)";
  const config = {
    value: { label, color },
  } satisfies ChartConfig;
  const data = (payload.points || []).map((point) => ({
    label: point.label,
    value: Number(point.value) || 0,
    display: point.display,
  }));
  const reduce =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const average = payload.average != null && Number.isFinite(Number(payload.average)) ? Number(payload.average) : null;
  const money = payload.format === "money";

  return (
    <ChartContainer config={config} className="schedi-report-chart" role="img" aria-label={captionFor(payload)}>
      <BarChart accessibilityLayer data={data} margin={{ top: 12, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" />
        <XAxis
          dataKey="label"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
          padding={{ left: 8, right: 8 }}
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={money ? 48 : 28}
          tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          tickFormatter={money ? axisMoney : axisCount}
          allowDecimals={false}
        />
        <ChartTooltip
          cursor={{ fill: "var(--border)", fillOpacity: 0.45 }}
          allowEscapeViewBox={{ x: true, y: true }}
          content={<ChartTooltipContent />}
        />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar
          dataKey="value"
          fill="var(--color-value)"
          radius={[4, 4, 0, 0]}
          isAnimationActive={!reduce}
          animationDuration={350}
        />
        {average != null ? (
          <ReferenceLine
            y={average}
            stroke="var(--chart-4)"
            strokeDasharray="4 4"
            ifOverflow="extendDomain"
          />
        ) : null}
      </BarChart>
    </ChartContainer>
  );
}
