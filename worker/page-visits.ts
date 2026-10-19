// Booking-page visit gauges in the existing AUTH_KV namespace (same id on
// schedi-web and schedi-email-worker). One key per business, per day, per
// isolate holds a running total. The isolate adds hits in memory and writes
// that total at most once a minute, so a burst is one KV put rather than a
// put per view.
//
// The value is only the integer count. No cookie, IP, user agent, or referrer
// is stored. Keys expire after 400 days.
//
// KV free tier is about 1,000 writes, 1,000 lists, and 100,000 reads per day.
// Steady traffic is roughly one write per business per isolate per minute
// while people are actually opening the page, not one write per hit. Opening
// Reports lists that business's keys and reads them once. Workers Paid raises
// the write ceiling (about 1 million writes per month) if a day ever passes
// the free quota. No new binding, database, or paid product.

export const PAGE_VISIT_TRACKING_START = "2026-10-19";
export const PAGE_VISIT_FLUSH_MS = 5000;
export const PAGE_VISIT_HOLD_MS = 60_000;
export const PAGE_VISIT_TTL_SECONDS = 400 * 24 * 60 * 60;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,40})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOT_A_BUSINESS = new Set([
  "index.html",
  "agency",
  "admin",
  "hq",
  "signup",
  "terms",
  "privacy",
  "help",
  "auth",
  "reset",
  "billing",
  "api",
  "www",
  "schedi",
  "index",
  "assets",
  "favicon.ico",
  "robots.txt",
  "sitemap.xml",
  "llms.txt",
  "manifest.json",
  "manifest.webmanifest",
  "firebase-messaging-sw.js",
  "hq-9h7p52",
  "portal",
  "portal-preview",
  "for",
  "pricing",
  "login",
  "marketing-boot.js",
  "marketing-theme.js",
]);

// Tokens that show up in scrapers, previews, and headless checks. A normal
// browser UA (Chrome, Safari, Firefox, Instagram, DuckDuckGo) does not match.
const BOT_UA =
  /googlebot|bingbot|duckduckbot|baiduspider|yandexbot|sogou |exabot|facebot|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|pinterestbot|redditbot|applebot|amazonbot|petalbot|ahrefs|semrush|mj12bot|dotbot|rogerbot|embedly|quora link preview|gptbot|chatgpt-user|oai-searchbot|claudebot|anthropic-ai|ccbot|perplexitybot|bytespider|adsbot-google|mediapartners-google|feedfetcher|storebot-google|google-inspectiontool|chrome-lighthouse|pagespeed|gtmetrix|pingdom|uptimerobot|statuscake|site24x7|headlesschrome|phantomjs|selenium|puppeteer|playwright|wget\/|curl\/|python-requests|python-urllib|go-http-client|java\/|libwww|httpie|scrapy|crawler|spider|slurp|archiver|blexbot|zoominfobot|dataforseo|serpstat|seekport|screaming frog|linkdex|megaindex|seznambot|qwantify|naverbot|yeti\/|previewbot|linkchecker/i;

export interface VisitKv {
  get(key: string): Promise<string | null>;
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list?(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete?: boolean;
    cursor?: string;
  }>;
}

export type VisitRequest = {
  method: string;
  hostname: string;
  pathname: string;
  searchParams: { get(name: string): string | null };
  userAgent: string;
  referer: string;
  secFetchDest: string;
  secFetchMode: string;
  secPurpose: string;
};

type Timing = { flushMs: number; holdMs: number };

const totals = new Map<string, number>();
const dirty = new Set<string>();
let loop: Promise<void> | null = null;
let lastFlushAt = 0;
let isolateId = createIsolateId();
let timing: Timing = { flushMs: PAGE_VISIT_FLUSH_MS, holdMs: PAGE_VISIT_HOLD_MS };

function createIsolateId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function resetPageVisitBufferForTests(): void {
  totals.clear();
  dirty.clear();
  loop = null;
  lastFlushAt = 0;
  isolateId = createIsolateId();
  timing = { flushMs: PAGE_VISIT_FLUSH_MS, holdMs: PAGE_VISIT_HOLD_MS };
}

export function setPageVisitIsolateForTests(id: string): void {
  isolateId = id.replace(/[^a-z0-9]/gi, "").slice(0, 24) || "iso";
  totals.clear();
  dirty.clear();
  lastFlushAt = 0;
}

export function pageVisitFlushForTests(): Promise<void> {
  return loop || Promise.resolve();
}

export function isBotUserAgent(userAgent: string): boolean {
  const ua = String(userAgent || "").trim();
  if (!ua) return false;
  return BOT_UA.test(ua);
}

export function isVisitPreviewHost(hostname: string): boolean {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return host.endsWith(".workers.dev");
}

function ownerSurfaceParams(params: { get(name: string): string | null }): boolean {
  if (params.get("demo") === "1") return true;
  const preview = (params.get("preview") || "").toLowerCase();
  if (preview === "1" || preview === "true") return true;
  const portal = (params.get("portal") || "").toLowerCase();
  if (portal === "login" || portal === "preview" || portal === "1") return true;
  if ((params.get("dash") || "").trim()) return true;
  return false;
}

function refererIsOwnerSurface(referer: string): boolean {
  if (!referer) return false;
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return false;
  }
  if (isVisitPreviewHost(url.hostname)) return true;
  const path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase() || "/";
  if (
    path === "/login" ||
    path === "/portal" ||
    path === "/portal-preview" ||
    path === "/hq" ||
    path === "/agency" ||
    path === "/signup" ||
    path === "/admin" ||
    path === "/auth" ||
    path === "/reset"
  ) {
    return true;
  }
  if (path.startsWith("/portal/") || path.startsWith("/hq/") || path.startsWith("/admin/") || path.startsWith("/auth/")) {
    return true;
  }
  return ownerSurfaceParams(url.searchParams);
}

export function bookingSlugFromPath(pathname: string): string | null {
  const collapsed = String(pathname || "/").replace(/\/+/g, "/");
  const stripped = collapsed.length > 1 && collapsed.endsWith("/") ? collapsed.slice(0, -1) : collapsed;
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  let first = parts[0];
  try {
    first = decodeURIComponent(first);
  } catch {
    return null;
  }
  first = first.toLowerCase();
  if (!SLUG_RE.test(first) || NOT_A_BUSINESS.has(first)) return null;
  return first;
}

export function shouldCountBookingVisit(input: VisitRequest): boolean {
  if (String(input.method || "").toUpperCase() !== "GET") return false;
  const host = String(input.hostname || "").toLowerCase().replace(/\.$/, "");
  if (host !== "schedi.app" && host !== "www.schedi.app") return false;
  if (isVisitPreviewHost(host)) return false;
  if (!bookingSlugFromPath(input.pathname)) return false;
  if (ownerSurfaceParams(input.searchParams)) return false;
  if (refererIsOwnerSurface(input.referer || "")) return false;
  if (isBotUserAgent(input.userAgent || "")) return false;
  const dest = String(input.secFetchDest || "").toLowerCase();
  if (dest && dest !== "document") return false;
  const mode = String(input.secFetchMode || "").toLowerCase();
  if (mode && mode !== "navigate") return false;
  const purpose = String(input.secPurpose || "").toLowerCase();
  if (purpose.includes("prefetch") || purpose.includes("prerender")) return false;
  return true;
}

export function visitDay(now: Date, timeZone: string | undefined): string {
  const tz = safeTimeZone(timeZone);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const map: Record<string, string> = {};
    for (const part of fmt.formatToParts(now)) {
      if (part.type !== "literal") map[part.type] = part.value;
    }
    if (map.year && map.month && map.day) return `${map.year}-${map.month}-${map.day}`;
  } catch {
    // Fall through to UTC.
  }
  return now.toISOString().slice(0, 10);
}

function safeTimeZone(timeZone: string | undefined): string {
  const tz = String(timeZone || "").trim() || "America/New_York";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "America/New_York";
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function gaugeKey(slug: string, day: string): string {
  return `pv1:${slug}:${day}:${isolateId}`;
}

async function flushNow(kv: VisitKv): Promise<void> {
  if (typeof kv.put !== "function") {
    dirty.clear();
    return;
  }
  const batch: Array<{ id: string; slug: string; day: string; count: number }> = [];
  for (const id of Array.from(dirty)) {
    dirty.delete(id);
    const count = totals.get(id) || 0;
    const tab = id.indexOf("\t");
    if (tab < 1 || count <= 0) continue;
    batch.push({ id, slug: id.slice(0, tab), day: id.slice(tab + 1), count });
  }
  for (const row of batch) {
    try {
      await kv.put(gaugeKey(row.slug, row.day), String(row.count), { expirationTtl: PAGE_VISIT_TTL_SECONDS });
      if ((totals.get(row.id) || 0) !== row.count) dirty.add(row.id);
    } catch (err) {
      dirty.add(row.id);
      console.error(
        JSON.stringify({
          message: "page visit flush failed",
          slug: row.slug,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  lastFlushAt = Date.now();
}

async function runLoop(kv: VisitKv, firstDelay: number): Promise<void> {
  await sleep(firstDelay);
  while (dirty.size) {
    if (lastFlushAt && timing.holdMs > 0) {
      const since = Date.now() - lastFlushAt;
      if (since < timing.holdMs) await sleep(timing.holdMs - since);
    }
    if (!dirty.size) return;
    await flushNow(kv);
  }
}

function arm(kv: VisitKv, ctx: { waitUntil?(promise: Promise<unknown>): void } | null | undefined): void {
  if (loop) return;
  const since = lastFlushAt ? Date.now() - lastFlushAt : Number.POSITIVE_INFINITY;
  const firstDelay = lastFlushAt && since < timing.holdMs ? Math.max(0, timing.holdMs - since) : timing.flushMs;
  const job = runLoop(kv, firstDelay).finally(() => {
    loop = null;
    if (dirty.size) arm(kv, null);
  });
  loop = job;
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job);
}

export function noteBookingVisit(
  kv: VisitKv | undefined,
  ctx: { waitUntil?(promise: Promise<unknown>): void } | null | undefined,
  slug: string,
  day: string,
  options?: { flushMs?: number; holdMs?: number },
): void {
  if (!kv || typeof kv.put !== "function") return;
  if (!SLUG_RE.test(slug) || !DAY_RE.test(day)) return;
  if (options) {
    if (options.flushMs != null && options.flushMs >= 0 && options.flushMs <= 120000) timing.flushMs = options.flushMs;
    if (options.holdMs != null && options.holdMs >= 0 && options.holdMs <= 120000) timing.holdMs = options.holdMs;
  }
  const id = `${slug}\t${day}`;
  totals.set(id, (totals.get(id) || 0) + 1);
  dirty.add(id);
  arm(kv, ctx);
}

export async function readBookingVisits(
  kv: VisitKv | undefined,
  slug: string,
  from: string,
  to: string,
): Promise<Record<string, number>> {
  const days: Record<string, number> = {};
  if (!kv || typeof kv.list !== "function" || typeof kv.get !== "function") return days;
  if (!SLUG_RE.test(slug)) return days;
  const prefix = `pv1:${slug}:`;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const listed: { keys?: { name?: string }[]; list_complete?: boolean; cursor?: string } = await kv.list({
      prefix,
      cursor,
      limit: 1000,
    });
    for (const item of listed.keys || []) {
      const name = String(item && item.name ? item.name : "");
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const day = rest.slice(0, 10);
      if (!DAY_RE.test(day) || rest.charAt(10) !== ":") continue;
      if (from && day < from) continue;
      if (to && day > to) continue;
      const raw = await kv.get(name);
      const count = Number(raw);
      if (!Number.isFinite(count) || count <= 0) continue;
      days[day] = (days[day] || 0) + Math.round(count);
    }
    if (listed.list_complete === false && listed.cursor) {
      cursor = listed.cursor;
      continue;
    }
    break;
  }
  return days;
}

export function totalVisitDays(days: Record<string, number>): number {
  let total = 0;
  for (const day of Object.keys(days)) total += Number(days[day]) || 0;
  return total;
}

function shiftIso(iso: string, days: number): string {
  const match = DAY_RE.exec(iso);
  if (!match) return "";
  const dt = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function parseVisitRange(fromRaw: string, toRaw: string): { from: string; to: string } | null {
  let from = String(fromRaw || "").slice(0, 10);
  let to = String(toRaw || "").slice(0, 10);
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) return null;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  const cap = shiftIso(from, 366);
  if (cap && to > cap) to = cap;
  return { from, to };
}

type VisitSession = { role?: string; tenantId?: string } | null;

export async function handlePageVisitsRequest(
  request: Request,
  env: { AUTH_KV?: VisitKv },
  origin: string,
  json: (body: unknown, status: number, origin: string) => Response,
  readSession: (env: { AUTH_KV?: VisitKv }, token: string) => Promise<VisitSession>,
): Promise<Response> {
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, origin);
  let body: { session?: unknown; from?: unknown; to?: unknown; tenantId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const token = String(body.session || "").trim().slice(0, 256);
  const session = token ? await readSession(env, token) : null;
  if (!session) return json({ ok: false, error: "session_required" }, 401, origin);
  const tenantId = String(session.tenantId || "").trim().toLowerCase();
  if (session.role !== "owner" || !SLUG_RE.test(tenantId)) {
    return json({ ok: false, error: "forbidden" }, 403, origin);
  }
  if (body.tenantId != null && String(body.tenantId).trim() && String(body.tenantId).trim().toLowerCase() !== tenantId) {
    return json({ ok: false, error: "forbidden" }, 403, origin);
  }
  const range = parseVisitRange(String(body.from || ""), String(body.to || ""));
  if (!range) return json({ ok: false, error: "invalid_range" }, 400, origin);
  const stored = await readBookingVisits(env.AUTH_KV, tenantId, range.from, range.to);
  const days: Record<string, number> = {};
  for (const day of Object.keys(stored)) {
    if (day < PAGE_VISIT_TRACKING_START || day < range.from || day > range.to) continue;
    days[day] = stored[day];
  }
  return json(
    {
      ok: true,
      trackingStart: PAGE_VISIT_TRACKING_START,
      from: range.from,
      to: range.to,
      total: totalVisitDays(days),
      days,
      partial: range.from < PAGE_VISIT_TRACKING_START,
    },
    200,
    origin,
  );
}
