import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleRequest, type SchediEnv } from "../worker/handler";
import { MOTION_SCRIPT_PATH, renderMarketingPage, REPORT_CHARTS_PATH } from "../worker/render";
import { MARKETING_PAGES } from "../worker/content";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const motionSource = readFileSync(new URL("../src/motion/entry.ts", import.meta.url), "utf8");
const chartSource = readFileSync(new URL("../src/components/ui/chart.tsx", import.meta.url), "utf8");
const reportSource = readFileSync(new URL("../src/components/report-chart.tsx", import.meta.url), "utf8");

function env(): SchediEnv {
  return { FIREBASE_PROJECT_ID: "siteforge-97699" };
}

describe("motion on marketing and owner pages", () => {
  it("loads the Motion library and skips animation when reduced motion is requested", () => {
    expect(motionSource).toContain('from "motion"');
    expect(motionSource).toContain("animate");
    expect(motionSource).toContain("inView");
    expect(motionSource).toContain("hover");
    expect(motionSource).toContain('"(prefers-reduced-motion: reduce)"');
    expect(html).toContain('<script src="/schedi-motion.js" defer></script>');
    expect(readFileSync(new URL("../site/hq.html", import.meta.url), "utf8")).toContain('<script src="/schedi-motion.js" defer></script>');
    const home = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/")!);
    expect(home).toContain(`<script src="${MOTION_SCRIPT_PATH}" defer></script>`);
    expect(MOTION_SCRIPT_PATH).toBe("/schedi-motion.js");
  });

  it("drops a settled translate on agenda and owner panels so fixed menus stay on the viewport", () => {
    const owner = motionSource.slice(motionSource.indexOf("function bootOwner"), motionSource.indexOf("function bootHq"));
    const todayBlocks = "#schediTodayPanel .sd-glance, #schediTodayPanel .sd-wait, #schediTodayPanel .sd-agenda, #schediTodayPanel .sd-ready";
    expect(owner).toContain(todayBlocks);
    expect(owner).toContain("releaseSettledTransform(");
    expect(owner.match(/releaseSettledTransform\(/g)).toHaveLength(2);
    expect(owner).toContain("OWNER_PANELS[next]");
    expect(owner).toContain("hover(");
    expect(owner).toContain("reducedMotion()");
    const helper = motionSource.slice(motionSource.indexOf("function settledTranslation"), motionSource.indexOf("function play"));
    expect(helper).toContain('style.transform = ""');
    expect(helper).toContain("translateY(0px)");
    expect(helper).toContain("translateX(0px)");
    expect(helper).toContain("requestAnimationFrame");
    const start = motionSource.slice(motionSource.indexOf("function start"));
    expect(start.indexOf("if (reducedMotion()) return;")).toBeGreaterThan(-1);
    expect(start.indexOf("if (reducedMotion()) return;")).toBeLessThan(start.indexOf("bootOwner()"));
  });

  it("serves the motion script from the worker, not the asset bucket", async () => {
    const response = await handleRequest(new Request("https://schedi.app/schedi-motion.js"), env(), { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const body = await response.text();
    expect(body).toContain("prefers-reduced-motion");
    expect(body).toContain("matrix(1,0,0,1,0,0)");
    expect(body.length).toBeGreaterThan(1000);
  });
});

describe("shadcn report charts", () => {
  it("uses ChartContainer, ChartTooltip, and ChartLegend on the same weekly data", () => {
    expect(chartSource).toContain("function ChartContainer");
    expect(chartSource).toContain("const ChartTooltip");
    expect(chartSource).toContain("function ChartTooltipContent");
    expect(chartSource).toContain("const ChartLegend");
    expect(chartSource).toContain("function ChartLegendContent");
    expect(chartSource).toContain("--color-");
    expect(reportSource).toContain("ChartContainer");
    expect(reportSource).toContain("ChartTooltip");
    expect(reportSource).toContain("ChartTooltipContent");
    expect(reportSource).toContain("ChartLegend");
    expect(reportSource).toContain("ChartLegendContent");
    expect(html).toContain("function reportChartSlot");
    expect(html).toContain("data-schedi-chart");
    expect(html).toContain("appointmentReportChartSvg");
    const report = html.slice(html.indexOf("function renderTenantReport"), html.indexOf("function buildReportPrintRoot"));
    expect(report).toContain("Visits by week");
    expect(report).toContain("Bookings by week");
    expect(report).toContain("Revenue by week");
    expect(report).toContain("Average appointments per week");
    expect(report).toContain("model.avgBookings");
    expect(report).toContain("model.avgRevenue");
    expect(report).toContain("mountSchediReportCharts");
  });

  it("serves the chart bundle from the worker", async () => {
    const response = await handleRequest(new Request("https://schedi.app/report-charts.js"), env(), { waitUntil() {} });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const body = await response.text();
    expect(REPORT_CHARTS_PATH).toBe("/report-charts.js");
    expect(body).toContain("SchediReportCharts");
    expect(body).toContain("data-slot");
  });
});
