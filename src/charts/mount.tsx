import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

declare global {
  interface Window {
    SchediReportCharts?: {
      mount: (root: ParentNode) => void;
      unmount: (root: ParentNode) => void;
    };
  }
}

import { ReportChart, type ReportChartPayload } from "@/components/report-chart";

const CHART_CSS = `
.sd-report-chart-slot {
  --chart-1: #34d399;
  --chart-2: #38bdf8;
  --chart-3: #a3e635;
  --chart-4: #94a3b8;
  --chart-5: #fbbf24;
  --background: #111827;
  --foreground: #f8fafc;
  --border: rgba(148, 163, 184, 0.28);
  --muted-foreground: #94a3b8;
  margin-top: 8px;
  min-height: 220px;
}
html.schedi-light .sd-report-chart-slot {
  --chart-1: #047857;
  --chart-2: #0369a1;
  --chart-3: #4d7c0f;
  --chart-4: #64748b;
  --background: #ffffff;
  --foreground: #0f172a;
  --border: rgba(15, 23, 42, 0.12);
  --muted-foreground: #64748b;
}
[data-slot="chart"] {
  width: 100%;
  height: 220px;
  color: var(--foreground);
  font-size: 12px;
  overflow: visible;
}
[data-slot="chart"] .recharts-wrapper,
[data-slot="chart"] .recharts-surface {
  overflow: visible !important;
}
[data-slot="chart"] .recharts-cartesian-axis-tick text {
  fill: var(--muted-foreground);
}
[data-slot="chart"] .recharts-cartesian-grid line {
  stroke: var(--border);
}
[data-slot="chart-tooltip"] {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 8rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--background);
  color: var(--foreground);
  padding: 8px 10px;
  font-size: 12px;
  line-height: 1.3;
  box-shadow: 0 16px 40px -24px rgba(0, 0, 0, 0.65);
}
.schedi-chart-tooltip-label {
  color: var(--muted-foreground);
  font-weight: 600;
}
.schedi-chart-tooltip-rows {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.schedi-chart-tooltip-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.schedi-chart-tooltip-indicator {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--schedi-indicator, var(--chart-1));
  flex: none;
}
.schedi-chart-tooltip-indicator.is-line,
.schedi-chart-tooltip-indicator.is-dashed {
  width: 12px;
  height: 2px;
  border-radius: 999px;
}
.schedi-chart-tooltip-indicator.is-dashed {
  background: transparent;
  border-top: 2px dashed var(--schedi-indicator, var(--chart-1));
}
.schedi-chart-tooltip-name {
  color: var(--muted-foreground);
}
.schedi-chart-tooltip-value {
  margin-left: auto;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
[data-slot="chart-legend"] {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px 14px;
  padding-top: 4px;
  color: var(--muted-foreground);
  font-size: 12px;
}
[data-slot="chart-legend"].is-top { padding-top: 0; padding-bottom: 4px; }
.schedi-chart-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.schedi-chart-legend-swatch {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}
.recharts-tooltip-wrapper { outline: none; }
`;

const roots = new Map<HTMLElement, Root>();

function ensureCss() {
  if (document.getElementById("schedi-chart-style")) return;
  const style = document.createElement("style");
  style.id = "schedi-chart-style";
  style.textContent = CHART_CSS;
  document.head.appendChild(style);
}

function readPayload(raw: string): ReportChartPayload | null {
  try {
    const data = JSON.parse(raw) as ReportChartPayload;
    if (!data || !Array.isArray(data.points)) return null;
    if (data.format !== "money" && data.format !== "count") data.format = "count";
    data.points = data.points.map((point) => ({
      label: String(point.label || ""),
      value: Number(point.value) || 0,
      display: String(point.display ?? point.value ?? ""),
    }));
    const average = data.average == null ? null : Number(data.average);
    data.average = average != null && Number.isFinite(average) ? average : null;
    data.title = String(data.title || data.label || "Chart");
    data.label = String(data.label || "Value");
    return data;
  } catch {
    return null;
  }
}

function mount(root: ParentNode) {
  ensureCss();
  root.querySelectorAll<HTMLElement>("[data-schedi-chart]").forEach((node) => {
    const raw = node.getAttribute("data-schedi-chart");
    if (!raw) return;
    const payload = readPayload(raw);
    if (!payload) return;
    let reactRoot = roots.get(node);
    if (!reactRoot) {
      node.replaceChildren();
      reactRoot = createRoot(node);
      roots.set(node, reactRoot);
    }
    flushSync(() => {
      reactRoot.render(<ReportChart payload={payload} />);
    });
  });
}

function unmount(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("[data-schedi-chart]").forEach((node) => {
    const reactRoot = roots.get(node);
    if (!reactRoot) return;
    reactRoot.unmount();
    roots.delete(node);
  });
}

window.SchediReportCharts = { mount, unmount };

export {};
