import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const shellHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hqHtml = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("could not extract " + name);
}

const blurb = new Function(
  `${extractFunction(bookingHtml, "escHtml")}
   ${extractFunction(bookingHtml, "publicServiceBlurb")}
   return publicServiceBlurb;`,
)() as (svc: unknown) => string;

describe("public booking service descriptions", () => {
  it("renders a saved description under the service name and escapes it", () => {
    const html = blurb({ name: "Cut", desc: 'Cut & style.\nAsk for "quiet" <time>.' });
    expect(html).toContain('class="svc-desc text-[11px] text-slate-400 font-normal mt-1 leading-snug whitespace-pre-line"');
    expect(html).toContain("Cut &amp; style.\nAsk for &quot;quiet&quot; &lt;time&gt;.");
    expect(html).not.toContain("<time>");
    expect(html).not.toContain('"quiet"');
    expect(blurb({ description: "Legacy overview" })).toContain("Legacy overview");
    expect(blurb({ desc: "Saved", description: "Ignored" })).toContain("Saved");
    expect(blurb({ desc: "Saved", description: "Ignored" })).not.toContain("Ignored");
  });

  it("omits the line when the description is missing or blank", () => {
    expect(blurb(null)).toBe("");
    expect(blurb({})).toBe("");
    expect(blurb({ desc: "" })).toBe("");
    expect(blurb({ desc: "   " })).toBe("");
    expect(blurb({ desc: null, description: null })).toBe("");
    expect(blurb({ desc: undefined })).toBe("");
    expect(blurb({ desc: "", description: "cleared on purpose" })).toBe("");
    expect(blurb({ description: "   " })).toBe("");
  });

  it("places the blurb in the public service card on every booking renderer", () => {
    for (const source of [bookingHtml, shellHtml, hqHtml]) {
      const render = extractFunction(source, "renderSvc");
      const card = render.slice(render.indexOf("return '<div class=\"flex items-center"));
      const nameAt = card.indexOf("escHtml(s.name)");
      const insertAt = card.indexOf("\n                    blurb +");
      const priceAt = card.indexOf("text-[11px] text-emerald-400 font-bold mt-1");
      expect(render).toContain("publicServiceBlurb(s)");
      expect(nameAt).toBeGreaterThan(-1);
      expect(insertAt).toBeGreaterThan(nameAt);
      expect(priceAt).toBeGreaterThan(insertAt);
      expect(extractFunction(source, "publicServiceBlurb")).toBe(extractFunction(bookingHtml, "publicServiceBlurb"));
    }
  });
});
