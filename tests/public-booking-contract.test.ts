import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("public booking card choice", () => {
  it("keeps every payment method choosable when a deposit or cancellation fee is on", () => {
    expect(html).not.toContain("Card deposit</div>");
    expect(html).not.toContain("if (depositQuote.required) selectedPay = 'card'");
    expect(html).not.toContain("booking.paymentMethod = 'card';\n                            booking.paymentStatus = 'AWAITING DEPOSIT'");
    expect(html).toContain("Card is optional");
    expect(html).toContain("Other ways to pay stay available");
    expect(html).toContain("onclick=\"selectPay('cashapp')\"");
    expect(html).toContain("onclick=\"selectPay('zelle')\"");
    expect(html).toContain("onclick=\"selectPay('venmo')\"");
    expect(html).toContain("onclick=\"selectPay('paypal')\"");
    expect(html).toContain("onclick=\"selectPay('later')\"");
  });

  it("opens Stripe from the top window and shows a short payment link on the request card", () => {
    expect(html).toContain('id="resCardPayLink"');
    expect(html).toContain('id="resCheckoutBtn"');
    expect(html).toContain('target="_top"');
    expect(html).toContain("function assignTopStripe");
    expect(html).toContain("function durableCardPayLink");
    expect(html).toContain("pay=checkout");
    const bookingScript = html.split('var STRIPE_CHECKOUT_ENDPOINT')[1] ?? "";
    expect(bookingScript).not.toContain("window.location.href = data.url");
    expect(bookingScript).not.toContain("window.location.href = out.data.url");
  });

  it("keeps schedi.app pay-link regexes valid inside the booking iframe script", () => {
    const rendered = renderStandaloneBookingHtml(html);
    const scripts = inlineScriptBodies(rendered);
    const booking = scripts.find((script) => script.body.includes("function durableCardPayLink"));
    expect(booking?.type ?? "").toBe("");
    const body = booking?.body ?? "";
    const escapedPayLink = "/^https:\\/\\/(www\\.)?schedi\\.app\\//.test(";
    expect(body.split(escapedPayLink).length - 1).toBe(2);
    expect(body).not.toContain("/^https://(www.)?schedi.app//");
    expect(body).toContain("window.toggleSchediTheme");
    expect(body).toContain("function renderSvc");
    expect(() => new Script(body, { filename: "public-booking-iframe.js" })).not.toThrow();

    for (const script of scripts) {
      if (script.type === "module") {
        expect(scriptParsesAsModule(script.body)).toBe(true);
      } else if (!script.type || script.type === "text/javascript") {
        expect(() => new Script(script.body, { filename: "public-booking-iframe.js" })).not.toThrow();
      }
    }
  });
});

/** Same escape pass the browser applies to the template returned by generateStandaloneHtmlForTenant. */
function renderStandaloneBookingHtml(page: string): string {
  const fnAt = page.indexOf("function generateStandaloneHtmlForTenant");
  if (fnAt < 0) throw new Error("generateStandaloneHtmlForTenant is missing");
  const returnAt = page.indexOf("return `<!DOCTYPE html>", fnAt);
  if (returnAt < 0) throw new Error("standalone booking template is missing");
  const start = page.indexOf("`", returnAt);
  const end = page.indexOf("</html>`;", start);
  if (start < 0 || end < 0) throw new Error("standalone booking template is not closed");
  const template = stripTemplateInterpolations(page.slice(start, end + "</html>`".length));
  return Function(`"use strict"; return (${template});`)() as string;
}

function stripTemplateInterpolations(source: string): string {
  let out = "";
  for (let i = 0; i < source.length; i++) {
    const ch = source[i] ?? "";
    if (ch === "\\" && i + 1 < source.length) {
      out += ch + source[i + 1];
      i++;
      continue;
    }
    if (ch === "$" && source[i + 1] === "{") {
      let j = i + 2;
      let depth = 1;
      let quote = "";
      while (j < source.length && depth > 0) {
        const c = source[j] ?? "";
        if (quote) {
          if (c === "\\" && j + 1 < source.length) {
            j += 2;
            continue;
          }
          if (c === quote) quote = "";
          j++;
          continue;
        }
        if (c === "'" || c === '"' || c === "`") {
          quote = c;
          j++;
          continue;
        }
        if (c === "{") depth++;
        else if (c === "}") depth--;
        j++;
      }
      out += "null";
      i = j - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

function inlineScriptBodies(doc: string): { type: string; body: string }[] {
  const scripts: { type: string; body: string }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(doc))) {
    const attrs = match[1] ?? "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const type = /type\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    if (type === "application/ld+json") continue;
    scripts.push({ type, body: match[2] ?? "" });
  }
  return scripts;
}

function scriptParsesAsModule(body: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "schedi-srcdoc-"));
  try {
    const file = join(dir, "iframe.mjs");
    writeFileSync(file, body);
    const checked = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    return checked.status === 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
