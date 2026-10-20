import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Workers route patterns match the whole URL, including the query string.
 * A pattern matches a query string only when it ends with `*`.
 * https://developers.cloudflare.com/workers/configuration/routing/routes/
 */
const toml = readFileSync(new URL("../workers/schedi-email-worker/wrangler.toml", import.meta.url), "utf8");

function routePatterns(source: string): string[] {
  return [...source.matchAll(/^pattern = "([^"]+)"$/gm)].map((match) => match[1]);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Match host + path + query the way a Workers route pattern does. */
function routeMatches(pattern: string, hostPathQuery: string): boolean {
  if (pattern.includes("?")) return false;
  const body = pattern.split("*").map(escapeRegex).join(".*");
  return new RegExp("^" + body + "$").test(hostPathQuery);
}

function matchedBy(patterns: string[], hostPathQuery: string): string | undefined {
  const hits = patterns.filter((pattern) => routeMatches(pattern, hostPathQuery));
  return hits.sort((a, b) => b.length - a.length)[0];
}

describe("email worker calendar routes", () => {
  const patterns = routePatterns(toml);
  const ownerToken = "a".repeat(48);

  it("gives calendar-busy a trailing * so ?tenant= reaches this worker", () => {
    expect(patterns).toContain("schedi.app/api/calendar-busy*");
    const withQuery = "schedi.app/api/calendar-busy?tenant=harbor";
    expect(routeMatches("schedi.app/api/calendar-busy", withQuery)).toBe(false);
    expect(matchedBy(patterns, withQuery)).toBe("schedi.app/api/calendar-busy*");
    expect(matchedBy(patterns, "schedi.app/api/calendar-busy")).toBe("schedi.app/api/calendar-busy*");
  });

  it("keeps a trailing * on PR #57 routes that use a query string or a subpath", () => {
    expect(patterns).toContain("schedi.app/api/owner-feed/*");
    const ics = `schedi.app/api/owner-feed/${ownerToken}.ics`;
    expect(matchedBy(patterns, ics)).toBe("schedi.app/api/owner-feed/*");
    expect(matchedBy(patterns, `${ics}?`)).toBe("schedi.app/api/owner-feed/*");

    // POST /api/calendar-feeds sends a JSON body and no query string.
    expect(patterns).toContain("schedi.app/api/calendar-feeds");
    expect(matchedBy(patterns, "schedi.app/api/calendar-feeds")).toBe("schedi.app/api/calendar-feeds");
    expect(routeMatches("schedi.app/api/calendar-feeds", "schedi.app/api/calendar-feeds?tenant=harbor")).toBe(false);
  });

  it("still matches booking-ics query strings the same way", () => {
    expect(patterns).toContain("schedi.app/api/booking-ics*");
    expect(matchedBy(patterns, "schedi.app/api/booking-ics?tenant=harbor&id=1&t=tok")).toBe("schedi.app/api/booking-ics*");
  });
});
