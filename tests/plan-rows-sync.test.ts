import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLAN_COMPARE_ROWS } from "../worker/content";

describe("plan compare rows", () => {
  it("match schediPlanCompareRows() in the SPA shell", () => {
    const html = readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
    const m = html.match(/function schediPlanCompareRows\(\) \{[\s\S]*?return (\[[\s\S]*?\]);\s*\}/);
    expect(m).not.toBeNull();
    const rows = new Function(`return ${m![1]};`)();
    expect(rows).toEqual(PLAN_COMPARE_ROWS);
  });
});
