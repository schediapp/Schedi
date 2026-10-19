// Booking-page visits in Workers Analytics Engine (dataset schedi_page_visits).
// schedi-web writes one data point per counted view during the request.
// schedi-email-worker reads totals with the SQL API for the signed-in owner.
//
// A data point is the business slug and the local day (YYYY-MM-DD). No cookie,
// IP, user agent, or referrer is stored. writeDataPoint returns immediately and
// the runtime sends it with the request, so there is no waitUntil timer and no
// in-memory lock that a cancelled flush can wedge.
//
// Workers Free includes 100,000 data points written per day and 10,000 SQL
// reads per day. 20 businesses at 50 views a day is 1,000 writes (1% of that
// write allowance) and one SQL read each time an owner opens Reports.
// AUTH_KV is not used for visits, so sign-in sessions keep its write quota.
// Points are kept for three months. Cloudflare is not billing Analytics Engine
// yet; the figures above are the published free allowances.

export const PAGE_VISIT_TRACKING_START = "2026-10-19";
export const PAGE_VISITS_DATASET = "schedi_page_visits";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,40})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCOUNT_RE = /^[a-f0-9]{32}$/i;
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

export interface PageVisitDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

export interface PageVisitQueryEnv {
  CF_ACCOUNT_ID?: string;
  ANALYTICS_API_TOKEN?: string;
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

export class PageVisitQueryError extends Error {
  readonly code: "visits_unconfigured" | "visits_unavailable";

  constructor(code: "visits_unconfigured" | "visits_unavailable") {
    super(code);
    this.name = "PageVisitQueryError";
    this.code = code;
  }
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

function shiftIso(iso: string, days: number): string {
  const dt = new Date(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function sqlString(value: string): string {
  return "'" + value.replace(/'/g, "") + "'";
}

// Local days are stored in blob2. The timestamp filter is only the required
// lower bound, widened by two days so a business timezone still matches.
export function pageVisitQuery(slug: string, from: string, to: string): string | null {
  if (!SLUG_RE.test(slug) || !DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return null;
  const start = shiftIso(from, -2);
  const end = shiftIso(to, 2);
  return [
    "SELECT blob2 AS day, SUM(_sample_interval) AS visits",
    "FROM " + PAGE_VISITS_DATASET,
    "WHERE blob1 = " + sqlString(slug),
    "AND blob2 >= " + sqlString(from),
    "AND blob2 <= " + sqlString(to),
    "AND timestamp >= toDateTime(" + sqlString(start + " 00:00:00") + ")",
    "AND timestamp < toDateTime(" + sqlString(end + " 00:00:00") + ")",
    "GROUP BY day",
    "FORMAT JSON",
  ].join(" ");
}

export function noteBookingVisit(dataset: PageVisitDataset | undefined, slug: string, day: string): void {
  if (!dataset || typeof dataset.writeDataPoint !== "function") return;
  if (!SLUG_RE.test(slug) || !DAY_RE.test(day) || day < PAGE_VISIT_TRACKING_START) return;
  try {
    dataset.writeDataPoint({
      indexes: [slug],
      blobs: [slug, day],
      doubles: [1],
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "page visit write failed",
        slug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

function datasetMissing(status: number, body: string): boolean {
  if (status === 404) return true;
  return /dataset[^\n]{0,80}(not found|does not exist)|(?:unknown|no such|missing) dataset/i.test(body);
}

function visitRows(payload: unknown): Record<string, number> {
  const data = payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: Array<{ day?: unknown; visits?: unknown }> }).data
    : [];
  const days: Record<string, number> = {};
  for (const row of data) {
    const day = String(row && row.day != null ? row.day : "");
    if (!DAY_RE.test(day) || day < PAGE_VISIT_TRACKING_START) continue;
    const count = Number(row.visits);
    if (!Number.isFinite(count) || count <= 0) continue;
    days[day] = (days[day] || 0) + Math.round(count);
  }
  return days;
}

export async function readBookingVisits(
  env: PageVisitQueryEnv | undefined,
  slug: string,
  from: string,
  to: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, number>> {
  const query = pageVisitQuery(slug, from, to);
  if (!query) return {};
  const account = String(env?.CF_ACCOUNT_ID || "").trim();
  const token = String(env?.ANALYTICS_API_TOKEN || "").trim();
  if (!ACCOUNT_RE.test(account) || !token || token.length > 4096 || /[\s]/.test(token)) {
    throw new PageVisitQueryError("visits_unconfigured");
  }
  const url = "https://api.cloudflare.com/client/v4/accounts/" + account + "/analytics_engine/sql";
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "text/plain; charset=utf-8",
      },
      body: query,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "page visit query failed",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    throw new PageVisitQueryError("visits_unavailable");
  }
  const body = await response.text();
  if (datasetMissing(response.status, body)) return {};
  if (!response.ok) {
    console.error(JSON.stringify({ message: "page visit query failed", status: response.status }));
    if (response.status === 401 || response.status === 403) throw new PageVisitQueryError("visits_unconfigured");
    throw new PageVisitQueryError("visits_unavailable");
  }
  let payload: unknown = {};
  try {
    payload = body ? JSON.parse(body) : {};
  } catch {
    throw new PageVisitQueryError("visits_unavailable");
  }
  if (payload && typeof payload === "object" && (payload as { success?: unknown }).success === false) {
    const encoded = JSON.stringify(payload);
    if (datasetMissing(response.status, encoded)) return {};
    throw new PageVisitQueryError("visits_unavailable");
  }
  return visitRows(payload);
}

export function totalVisitDays(days: Record<string, number>): number {
  let total = 0;
  for (const day of Object.keys(days)) total += Number(days[day]) || 0;
  return total;
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
type SessionKv = { get(key: string): Promise<string | null> };

export async function handlePageVisitsRequest(
  request: Request,
  env: PageVisitQueryEnv & { AUTH_KV?: SessionKv },
  origin: string,
  json: (body: unknown, status: number, origin: string) => Response,
  readSession: (env: { AUTH_KV?: SessionKv }, token: string) => Promise<VisitSession>,
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
  let stored: Record<string, number>;
  try {
    stored = await readBookingVisits(env, tenantId, range.from, range.to);
  } catch (err) {
    const code = err instanceof PageVisitQueryError ? err.code : "visits_unavailable";
    return json({ ok: false, error: code }, 503, origin);
  }
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
