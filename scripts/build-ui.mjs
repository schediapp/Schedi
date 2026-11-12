import { readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

async function bundle(entry, outfile) {
  await build({
    entryPoints: [entry],
    bundle: true,
    format: "iife",
    platform: "browser",
    minify: true,
    legalComments: "none",
    target: ["es2018"],
    jsx: "automatic",
    absWorkingDir: process.cwd(),
    alias: { "@": "./src" },
    define: { "process.env.NODE_ENV": '"production"' },
    outfile,
  });
}

function emitModule(jsPath, tsPath, exportName) {
  const source = readFileSync(jsPath, "utf8");
  writeFileSync(tsPath, `export const ${exportName}: string = ${JSON.stringify(source)};\n`);
}

await bundle("src/motion/entry.ts", "worker/generated/browser/schedi-motion.js");
await bundle("src/charts/mount.tsx", "worker/generated/browser/report-charts.js");
emitModule("worker/generated/browser/schedi-motion.js", "worker/generated/schedi-motion.ts", "motionSource");
emitModule("worker/generated/browser/report-charts.js", "worker/generated/report-charts.ts", "reportChartsSource");

const motion = readFileSync("worker/generated/browser/schedi-motion.js", "utf8");
const charts = readFileSync("worker/generated/browser/report-charts.js", "utf8");
if (!motion.includes("prefers-reduced-motion")) throw new Error("motion bundle dropped the reduced-motion check");
if (!charts.includes("SchediReportCharts")) throw new Error("chart bundle dropped the mount API");
if (!charts.includes("data-slot")) throw new Error("chart bundle dropped the shadcn chart slot");
console.log("motion", motion.length, "charts", charts.length);
