"use client";

import * as React from "react";
import * as RechartsPrimitive from "recharts";

import { cn } from "@/lib/utils";

// Schedi's owner portal marks light mode with html.schedi-light.
// The empty selector is the default dark dashboard.
const THEMES = { dark: "", light: "html.schedi-light" } as const;

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
>;

type ChartContextProps = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />");
  }
  return context;
}

const INITIAL_DIMENSION = { width: 360, height: 180 } as const;

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
  initialDimension?: { width: number; height: number };
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`;

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn("schedi-chart", className)}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={initialDimension}
          minWidth={0}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

function ChartStyle({ id, config }: { id: string; config: ChartConfig }) {
  const colorConfig = Object.entries(config).filter(([, item]) => item.theme || item.color);
  if (!colorConfig.length) return null;

  const css = Object.entries(THEMES)
    .map(([theme, prefix]) => {
      const lines = colorConfig
        .map(([key, itemConfig]) => {
          const color =
            itemConfig.theme?.[theme as keyof typeof itemConfig.theme] || itemConfig.color;
          return color ? `  --color-${key}: ${color};` : null;
        })
        .filter(Boolean)
        .join("\n");
      const scope = prefix ? `${prefix} ` : "";
      return `${scope}[data-chart="${id}"] {\n${lines}\n}`;
    })
    .join("\n");

  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

const ChartTooltip = RechartsPrimitive.Tooltip;

type TooltipItem = {
  type?: string;
  color?: string;
  name?: string | number;
  value?: string | number | ReadonlyArray<string | number>;
  dataKey?: string | number;
  payload?: { fill?: string; display?: string };
};

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  color,
  nameKey,
  labelKey,
}: React.ComponentProps<"div"> & {
  active?: boolean;
  payload?: ReadonlyArray<TooltipItem>;
  hideLabel?: boolean;
  hideIndicator?: boolean;
  indicator?: "line" | "dot" | "dashed";
  label?: React.ReactNode;
  labelFormatter?: (value: React.ReactNode, payload: ReadonlyArray<TooltipItem>) => React.ReactNode;
  labelClassName?: string;
  formatter?: (
    value: TooltipItem["value"],
    name: TooltipItem["name"],
    item: TooltipItem,
    index: number,
    payload: TooltipItem["payload"],
  ) => React.ReactNode;
  color?: string;
  nameKey?: string;
  labelKey?: string;
}) {
  const { config } = useChart();

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) return null;
    const [item] = payload;
    const key = `${labelKey || item?.dataKey || item?.name || "value"}`;
    const itemConfig = getPayloadConfigFromPayload(config, item, key);
    const value =
      !labelKey && typeof label === "string" ? config[label]?.label || label : itemConfig?.label;
    if (labelFormatter) {
      return (
        <div data-slot="chart-tooltip-label" className={cn("schedi-chart-tooltip-label", labelClassName)}>
          {labelFormatter(value, payload)}
        </div>
      );
    }
    if (!value) return null;
    return (
      <div data-slot="chart-tooltip-label" className={cn("schedi-chart-tooltip-label", labelClassName)}>
        {value}
      </div>
    );
  }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

  if (!active || !payload?.length) return null;

  const nestLabel = payload.length === 1 && indicator !== "dot";

  return (
    <div data-slot="chart-tooltip" className={cn("schedi-chart-tooltip", className)}>
      {!nestLabel ? tooltipLabel : null}
      <div className="schedi-chart-tooltip-rows">
        {payload
          .filter((item) => item.type !== "none")
          .map((item, index) => {
            const key = `${nameKey || item.name || item.dataKey || "value"}`;
            const itemConfig = getPayloadConfigFromPayload(config, item, key);
            const indicatorColor = color || item.payload?.fill || item.color;
            const shown =
              item.payload?.display ||
              (typeof item.value === "number" ? item.value.toLocaleString() : String(item.value ?? ""));
            return (
              <div key={`${key}-${index}`} className="schedi-chart-tooltip-row">
                {formatter && item.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <span
                          data-slot="chart-tooltip-indicator"
                          className={cn("schedi-chart-tooltip-indicator", `is-${indicator}`)}
                          style={{ "--schedi-indicator": indicatorColor } as React.CSSProperties}
                        />
                      )
                    )}
                    <span className="schedi-chart-tooltip-name">
                      {nestLabel ? tooltipLabel : null}
                      {itemConfig?.label || item.name}
                    </span>
                    <span className="schedi-chart-tooltip-value">{shown}</span>
                  </>
                )}
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

type LegendItem = {
  type?: string;
  color?: string;
  value?: string;
  dataKey?: string | number;
};

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
}: React.ComponentProps<"div"> & {
  hideIcon?: boolean;
  payload?: ReadonlyArray<LegendItem>;
  verticalAlign?: "top" | "bottom" | "middle";
  nameKey?: string;
}) {
  const { config } = useChart();
  if (!payload?.length) return null;

  return (
    <div
      data-slot="chart-legend"
      className={cn("schedi-chart-legend", verticalAlign === "top" ? "is-top" : "is-bottom", className)}
    >
      {payload
        .filter((item) => item.type !== "none")
        .map((item, index) => {
          const key = `${nameKey || item.dataKey || "value"}`;
          const itemConfig = getPayloadConfigFromPayload(config, item, key);
          if (!itemConfig?.label) return null;
          return (
            <div key={`${key}-${index}`} className="schedi-chart-legend-item">
              {itemConfig.icon && !hideIcon ? (
                <itemConfig.icon />
              ) : (
                <span
                  data-slot="chart-legend-indicator"
                  className="schedi-chart-legend-swatch"
                  style={{ background: item.color }}
                />
              )}
              {itemConfig.label}
            </div>
          );
        })}
    </div>
  );
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
  if (typeof payload !== "object" || payload === null) return undefined;

  const nested =
    "payload" in payload && typeof payload.payload === "object" && payload.payload !== null
      ? (payload.payload as Record<string, unknown>)
      : undefined;

  let configLabelKey = key;
  const record = payload as Record<string, unknown>;
  if (key in record && typeof record[key] === "string") {
    configLabelKey = record[key] as string;
  } else if (nested && key in nested && typeof nested[key] === "string") {
    configLabelKey = nested[key] as string;
  }

  return configLabelKey in config ? config[configLabelKey] : config[key];
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, ChartStyle };
