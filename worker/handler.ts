// schedi-web request handler.
// Marketing routes are rendered here so crawlers see distinct HTML.
// App and tenant routes keep the SPA shell. Unknown marketing paths are real 404s.

import { publicDuplicateRedirect } from "./canonical";
import { marketingPage, publicPaths } from "./content";
import { indexNowKey } from "./indexnow";
import {
  bookingMissingHtml,
  bookingPaused,
  bookingPausedHtml,
  bookingPayFromSearch,
  fillBookingDocument,
  isBookingDocument,
} from "./booking-document";
import { BOOKING_MASK_FIELDS } from "./booking-page-keep.js";
import { decodeFirestoreFields, localBusinessJsonLd, localBusinessScript, tenantFromFirestore, type TenantSeo } from "./local-business";
import { noteBookingVisit, type PageVisitDataset, shouldCountBookingVisit, visitDay } from "./page-visits";
import {
  agencySessionToken,
  HQ_PATHS,
  hqLoginDocument,
  requireAgency,
  stripPublicShell,
  type AgencyKv,
} from "./public-shell";
import {
  HERO_PATH,
  HERO_SVG,
  renderMarketingBoot,
  renderMarketingTheme,
  THEME_SCRIPT_PATH,
  renderDisallowAllRobots,
  renderLlms,
  renderMarketingPage,
  renderNotFound,
  renderRobots,
  renderSecurityTxt,
  renderSitemap,
} from "./render";
import { routeBusinessLogo, type LogoBucket } from "./logo-route";
import { injectWebAnalytics, WEB_ANALYTICS_CONNECT_ORIGIN, WEB_ANALYTICS_SCRIPT_ORIGIN } from "./web-analytics";

export interface AssetFetcher {
  fetch(input: Request): Promise<Response>;
}

export interface SchediEnv {
  ASSETS?: AssetFetcher;
  FIREBASE_PROJECT_ID?: string;
  /** Same AUTH_KV namespace as schedi-email-worker. Required to serve /hq. Visit counts do not use it. */
  AUTH_KV?: AgencyKv;
  /** Workers Analytics Engine dataset schedi_page_visits. One point per counted booking-page view. */
  PAGE_VISITS?: PageVisitDataset;
  /** IndexNow key file. Never hardcoded. 32–128 hex characters. */
  INDEXNOW_KEY?: string;
  INDEXNOW_ENABLED?: string;
  INDEXNOW_HOST?: string;
  /** Optional Bing Webmaster meta token. Omitted from HTML when unset or invalid. */
  BING_SITE_VERIFICATION?: string;
  /** R2 bucket for business logos. Missing binding: uploads return logo_storage_unconfigured. */
  LOGO_BUCKET?: LogoBucket;
}

export interface SchediContext {
  waitUntil(promise: Promise<unknown>): void;
}

const SHELL_TITLE = "<title>Schedi</title>";

const RESERVED = new Set([
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
  "manifest.json",
  "manifest.webmanifest",
  "firebase-messaging-sw.js",
  "hq-9h7p52",
  "portal",
  "for",
  "pricing",
  "login",
  "features",
  "compare",
  "faq",
  "portal-preview",
  "marketing-boot.js",
  "marketing-theme.js",
]);

const STATIC_TYPES: Record<string, string> = {
  "/favicon.ico": "image/x-icon",
  "/manifest.json": "application/json; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
  "/firebase-messaging-sw.js": "text/javascript; charset=utf-8",
};

const SPA_EXACT = new Set(["login", "signup", "reset", "auth", "agency", "hq", "hq-9h7p52", "portal-preview"]);

export function contentSecurityPolicy(html: boolean): string {
  if (!html) return "";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self' https://schedi.app https://checkout.stripe.com",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://www.gstatic.com ${WEB_ANALYTICS_SCRIPT_ORIGIN}`,
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob: https:",
    `connect-src 'self' https://schedi.app https://schedi-connect-production.up.railway.app https://*.googleapis.com https://*.firebasestorage.app https://*.firebaseio.com wss://*.firebaseio.com ${WEB_ANALYTICS_CONNECT_ORIGIN}`,
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
    "manifest-src 'self'",
  ].join("; ");
}

export function marketingContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' ${WEB_ANALYTICS_SCRIPT_ORIGIN}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src 'self' ${WEB_ANALYTICS_CONNECT_ORIGIN}`,
    "frame-src 'none'",
    "manifest-src 'self'",
  ].join("; ");
}

export const STRICT_TRANSPORT_SECURITY = "max-age=31536000; includeSubDomains";
export const PERMISSIONS_POLICY = "camera=(), microphone=(), geolocation=(), payment=()";
export const CROSS_ORIGIN_OPENER_POLICY = "same-origin-allow-popups";
export const CROSS_ORIGIN_RESOURCE_POLICY = "same-origin";

export function applySecurityHeaders(headers: Headers, html: boolean): void {
  headers.set("Strict-Transport-Security", STRICT_TRANSPORT_SECURITY);
  headers.set("Permissions-Policy", PERMISSIONS_POLICY);
  headers.set("Cross-Origin-Opener-Policy", CROSS_ORIGIN_OPENER_POLICY);
  headers.set("Cross-Origin-Resource-Policy", CROSS_ORIGIN_RESOURCE_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if ((headers.get("Access-Control-Allow-Origin") || "").trim() === "*") {
    headers.delete("Access-Control-Allow-Origin");
  }
  if (html) {
    headers.set("Content-Security-Policy", contentSecurityPolicy(true));
    headers.set("X-Frame-Options", "DENY");
  }
}

function collapse(pathname: string): string {
  const collapsed = (pathname || "/").replace(/\/+/g, "/");
  return collapsed || "/";
}

function stripTrailing(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname || "/";
}

function decodePart(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isPreviewHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  return host.endsWith(".workers.dev");
}

function isProductionHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  return host === "schedi.app" || host === "www.schedi.app";
}

function wantsPortal(url: URL): boolean {
  if (stripTrailing(collapse(url.pathname)) !== "/") return false;
  const portal = url.searchParams.get("portal");
  if (portal === "login") return true;
  if (url.searchParams.get("forgot") === "1") return true;
  if (url.searchParams.has("billing")) return true;
  // Sample dashboard flags stay on preview hosts. Production home stays the marketing page.
  if (!isPreviewHost(url.hostname)) return false;
  if (url.searchParams.get("demo") === "1") return true;
  if (url.searchParams.get("newdash") === "1") return true;
  return false;
}

function isApiOrBilling(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/billing" || pathname.startsWith("/billing/");
}

function hasFileExtension(pathname: string): boolean {
  const last = pathname.split("/").pop() || "";
  return /\.[a-z0-9]{1,12}$/i.test(last);
}

function isStaticFile(pathname: string): boolean {
  if (pathname === HERO_PATH || pathname === "/marketing-boot.js" || pathname === THEME_SCRIPT_PATH) return false;
  if (pathname === "/robots.txt" || pathname === "/sitemap.xml" || pathname.toLowerCase() === "/llms.txt") return false;
  if (pathname.toLowerCase() === "/.well-known/security.txt") return false;
  if (STATIC_TYPES[pathname]) return true;
  if (pathname.startsWith("/assets/")) return true;
  if (hasFileExtension(pathname)) return true;
  return false;
}

type SpaKind =
  | { kind: "spa"; slug: string | null; indexable: boolean }
  | { kind: "no" };

function classifySpa(stripped: string): SpaKind {
  const rawParts = stripped.split("/").filter(Boolean);
  const parts: string[] = [];
  for (const part of rawParts) {
    const decoded = decodePart(part);
    if (decoded === null) return { kind: "no" };
    parts.push(decoded);
  }
  if (!parts.length) return { kind: "no" };
  const first = parts[0].toLowerCase();
  if (SPA_EXACT.has(first) && parts.length === 1) {
    return { kind: "spa", slug: null, indexable: false };
  }
  if ((first === "portal" || first === "admin") && parts.length >= 1) {
    return { kind: "spa", slug: null, indexable: false };
  }
  if (first === "help" && parts.length === 2 && parts[1].toLowerCase() === "booking") {
    return { kind: "spa", slug: null, indexable: false };
  }
  if (RESERVED.has(first)) return { kind: "no" };
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/i.test(first)) return { kind: "no" };
  const slug = first.toLowerCase();
  if (parts.length === 1) return { kind: "spa", slug, indexable: false };
  // Manage stays on the owner shell. Reschedule and cancel are enterPublicManageMode
  // in index.html, not in the booking document. booking.html only builds the
  // manage link for confirmation mail, so serving it here would replace the
  // manage flow with the public booking form.
  if (parts[1].toLowerCase() === "manage") return { kind: "spa", slug: null, indexable: false };
  return { kind: "no" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function bookingDescription(name: string, industry: string): string {
  const who = name.replace(/\s+/g, " ").trim() || "this business";
  const trade = industry.replace(/\s+/g, " ").trim();
  if (!trade || /^services?$/i.test(trade)) {
    return `Book an appointment with ${who}. Live online scheduling.`;
  }
  return `Book an appointment with ${who}. ${trade} appointments with live online scheduling.`;
}

function bookingTitle(name: string): string {
  const who = name.replace(/\s+/g, " ").trim() || "Schedi";
  return `Book an Appointment | ${who}`;
}

export function injectBookingMeta(
  html: string,
  meta: { name: string; title: string; description: string; canonical: string },
): string {
  const at = html.indexOf(SHELL_TITLE);
  if (at < 0) return html;
  const scriptAt = html.indexOf("<script");
  if (scriptAt !== -1 && at > scriptAt) return html;
  const head = [
    `<title>${escapeHtml(meta.title)}</title>`,
    `<meta name="description" content="${escapeHtml(meta.description)}">`,
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeHtml(meta.name)}">`,
    `<meta property="og:title" content="${escapeHtml(meta.title)}">`,
    `<meta property="og:description" content="${escapeHtml(meta.description)}">`,
    `<meta property="og:url" content="${escapeHtml(meta.canonical)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(meta.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(meta.description)}">`,
  ].join("\n    ");
  return html.slice(0, at) + head + html.slice(at + SHELL_TITLE.length);
}

function injectNoindex(html: string): string {
  const tag = `<meta name="robots" content="noindex, follow">`;
  const headOpen = html.search(/<head\b[^>]*>/i);
  const headClose = html.search(/<\/head>/i);
  const headHtml = headOpen >= 0 && headClose > headOpen ? html.slice(headOpen, headClose) : "";
  if (headHtml.includes('name="robots"') || headHtml.includes("name='robots'")) return html;
  if (headOpen >= 0) {
    const insertAt = html.indexOf(">", headOpen) + 1;
    return html.slice(0, insertAt) + tag + html.slice(insertAt);
  }
  return tag + html;
}

export { tenantFromFirestore };

export const BOOKING_FIELD_MASK = BOOKING_MASK_FIELDS.map((field) => `mask.fieldPaths=${encodeURIComponent(field)}`).join("&");

type TenantLookup = {
  tenant: TenantSeo | null;
  missing: boolean;
  paused: boolean;
  fields: Record<string, unknown> | null;
};

function interpretTenant(document: unknown): TenantLookup {
  const tenant = tenantFromFirestore(document);
  const fields = decodeFirestoreFields(document);
  if (!tenant || !fields) return { tenant: null, missing: false, paused: false, fields: null };
  return { tenant, missing: false, paused: bookingPaused(fields), fields };
}

async function lookupTenant(slug: string, env: SchediEnv, ctx: SchediContext): Promise<TenantLookup> {
  const empty: TenantLookup = { tenant: null, missing: false, paused: false, fields: null };
  const projectId = env.FIREBASE_PROJECT_ID || "";
  if (!projectId || !/^[a-z0-9-]+$/i.test(projectId)) return empty;
  const endpoint =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/${projectId}/public/data/tenants/${slug}` +
    `?${BOOKING_FIELD_MASK}`;
  const cacheKey = new Request(`https://schedi-meta.invalid/tenant2/${projectId}/${slug}`);
  try {
    const cached = await cacheMatch(cacheKey);
    if (cached) {
      if (cached.status === 404) return { tenant: null, missing: true, paused: false, fields: null };
      return interpretTenant(await cached.json());
    }
    const res = await fetch(endpoint);
    if (res.status === 404) {
      await cachePut(
        ctx,
        cacheKey,
        new Response("", { status: 404, headers: { "Cache-Control": "public, max-age=60" } }),
      );
      return { tenant: null, missing: true, paused: false, fields: null };
    }
    if (!res.ok) {
      console.error(JSON.stringify({ message: "tenant lookup failed", slug, status: res.status }));
      return empty;
    }
    const document = await res.json();
    const lookup = interpretTenant(document);
    if (!lookup.tenant) return empty;
    await cachePut(
      ctx,
      cacheKey,
      new Response(JSON.stringify(document), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" },
      }),
    );
    return lookup;
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "tenant lookup failed",
        slug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return empty;
  }
}

async function cacheMatch(request: Request): Promise<Response | null> {
  try {
    const store = (globalThis as { caches?: { default?: { match(request: Request): Promise<Response | undefined> } } }).caches;
    if (!store?.default) return null;
    return (await store.default.match(request)) ?? null;
  } catch {
    return null;
  }
}

async function cachePut(ctx: SchediContext, request: Request, response: Response): Promise<void> {
  try {
    const store = (globalThis as { caches?: { default?: { put(request: Request, response: Response): Promise<void> } } }).caches;
    if (!store?.default) return;
    const put = store.default.put(request, response);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  } catch {
    // Cache is an optimization. A failed write still returns the lookup result.
  }
}

function textResponse(
  body: string | null,
  status: number,
  contentType: string,
  extra: Record<string, string>,
  method: string,
): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", contentType);
  const html = contentType.includes("text/html");
  applySecurityHeaders(headers, html);
  if (html && contentType.includes("text/html") && !headers.has("Content-Security-Policy")) {
    headers.set("Content-Security-Policy", contentSecurityPolicy(true));
  }
  if (method === "HEAD") return new Response(null, { status, headers });
  return new Response(body, { status, headers });
}

function marketingResponse(html: string, method: string, pageUrl: URL, status = 200): Response {
  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", marketingContentSecurityPolicy());
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "public, max-age=600");
  applySecurityHeaders(headers, false);
  headers.set("Content-Security-Policy", marketingContentSecurityPolicy());
  const body = injectWebAnalytics(html, pageUrl);
  if (method === "HEAD") return new Response(null, { status, headers });
  return new Response(body, { status, headers });
}

function redirect(location: string, status: number): Response {
  const headers = new Headers();
  applySecurityHeaders(headers, false);
  headers.set("Location", location);
  headers.set("Cache-Control", "no-store");
  return new Response(null, { status, headers });
}

async function discard(response: Response): Promise<void> {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    // Already consumed.
  }
}

async function fetchAsset(request: Request, env: SchediEnv): Promise<Response | null> {
  if (!env.ASSETS) return null;
  return env.ASSETS.fetch(request);
}

async function fetchShell(request: Request, env: SchediEnv): Promise<Response | null> {
  if (!env.ASSETS) return null;
  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/index.html";
  indexUrl.search = "";
  return env.ASSETS.fetch(new Request(indexUrl.toString(), { method: "GET" }));
}

async function fetchBookingShell(request: Request, env: SchediEnv): Promise<Response | null> {
  if (!env.ASSETS) return null;
  const bookingUrl = new URL(request.url);
  bookingUrl.pathname = "/booking.html";
  bookingUrl.search = "";
  return env.ASSETS.fetch(new Request(bookingUrl.toString(), { method: "GET" }));
}

async function fetchHqShell(request: Request, env: SchediEnv): Promise<Response | null> {
  if (!env.ASSETS) return null;
  const hqUrl = new URL(request.url);
  hqUrl.pathname = "/hq.html";
  hqUrl.search = "";
  return env.ASSETS.fetch(new Request(hqUrl.toString(), { method: "GET" }));
}

function isHqSpaPath(pathname: string): boolean {
  const parts = stripTrailing(collapse(pathname)).split("/").filter(Boolean);
  if (parts.length !== 1) return false;
  let first = parts[0] || "";
  try {
    first = decodeURIComponent(first);
  } catch {
    return false;
  }
  return HQ_PATHS.has(first.toLowerCase());
}

function exactAppPath(pathname: string): string | null {
  let stripped = stripTrailing(collapse(pathname));
  try {
    stripped = decodeURIComponent(stripped);
  } catch {
    return null;
  }
  return stripped.toLowerCase();
}

function isPortalPreviewPath(pathname: string): boolean {
  return exactAppPath(pathname) === "/portal-preview";
}

function hasNamedBusiness(url: URL): boolean {
  for (const key of ["biz", "tenant"]) {
    for (const value of url.searchParams.getAll(key)) {
      if (value.trim()) return true;
    }
  }
  return false;
}

// Owner sign-in. dropPreviewParams removes demo/biz/tenant from the sample
// dashboard link and keeps classic, newdash, dash, and anything else.
function ownerLoginLocation(url: URL, dropPreviewParams: boolean): string {
  const dest = new URL(url.toString());
  dest.protocol = "https:";
  dest.hostname = "schedi.app";
  dest.port = "";
  dest.pathname = "/login";
  if (dropPreviewParams) {
    dest.searchParams.delete("demo");
    dest.searchParams.delete("biz");
    dest.searchParams.delete("tenant");
  }
  return dest.toString();
}

export async function handleRequest(request: Request, env: SchediEnv, ctx: SchediContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const logoResponse = await routeBusinessLogo(request, env);
  if (logoResponse) return logoResponse;
  // Production /portal with no business is not a booking page. The SPA would
  // treat "portal" as a slug and show "Booking page not found". Send that
  // request to /login and keep classic, newdash, dash, and other params.
  // A returning owner already reaches the dashboard from /login: the page
  // reads schedi.authSession, applySchediAuthMetaOptimistic marks them signed
  // in, and switchPlatformMode('tenant') hides the login box and paints the
  // portal. verifySchediAuthSessionRestore then calls openTenantOwnerPortal.
  // /portal-preview is the sample dashboard. Preview hosts still serve it.
  // Production goes straight to /login, keeping classic/newdash and dropping
  // demo, biz, and tenant so the sample link cannot land on the error card.
  // This runs before the marketing canonical redirect, which would otherwise
  // drop biz, tenant, dash, demo, and newdash on the way to /login.
  if ((method === "GET" || method === "HEAD") && !isPreviewHost(url.hostname)) {
    if (isPortalPreviewPath(url.pathname)) return redirect(ownerLoginLocation(url, true), 302);
    if (exactAppPath(url.pathname) === "/portal" && !hasNamedBusiness(url)) {
      return redirect(ownerLoginLocation(url, false), 302);
    }
  }
  const canonicalLocation = publicDuplicateRedirect(url);
  if (canonicalLocation) return redirect(canonicalLocation, 301);
  if (method !== "GET" && method !== "HEAD") {
    if (isApiOrBilling(url.pathname)) return apiNotFound(method);
    return textResponse("Method not allowed\n", 405, "text/plain; charset=utf-8", { Allow: "GET, HEAD" }, method);
  }

  const collapsed = collapse(url.pathname);
  if (collapsed === "/robots.txt") {
    const robots = isProductionHost(url.hostname) ? renderRobots() : renderDisallowAllRobots();
    return textResponse(robots, 200, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=3600" }, method);
  }
  if (collapsed === "/sitemap.xml") {
    return textResponse(
      renderSitemap(),
      200,
      "application/xml; charset=utf-8",
      { "Cache-Control": "public, max-age=3600" },
      method,
    );
  }
  if (collapsed.toLowerCase() === "/llms.txt") {
    return textResponse(renderLlms(), 200, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=3600" }, method);
  }
  if (collapsed.toLowerCase() === "/.well-known/security.txt") {
    return textResponse(renderSecurityTxt(), 200, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=3600" }, method);
  }
  const indexNow = indexNowKey(env);
  if (indexNow && collapsed.toLowerCase() === `/${indexNow}.txt`) {
    return textResponse(indexNow, 200, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=3600" }, method);
  }
  if (collapsed === THEME_SCRIPT_PATH) {
    return textResponse(
      renderMarketingTheme(),
      200,
      "text/javascript; charset=utf-8",
      { "Cache-Control": "public, max-age=3600" },
      method,
    );
  }
  if (collapsed === "/marketing-boot.js") {
    return textResponse(
      renderMarketingBoot(),
      200,
      "text/javascript; charset=utf-8",
      { "Cache-Control": "public, max-age=3600" },
      method,
    );
  }
  if (collapsed === HERO_PATH) {
    return textResponse(HERO_SVG, 200, "image/svg+xml; charset=utf-8", { "Cache-Control": "public, max-age=86400" }, method);
  }

  if (isApiOrBilling(collapsed)) return apiNotFound(method);

  if (isStaticFile(collapsed)) {
    const asset = await fetchAsset(request, env);
    return guardStatic(asset, collapsed, method);
  }

  const stripped = stripTrailing(collapsed);
  let lower = stripped.toLowerCase();
  try {
    lower = decodeURIComponent(stripped).toLowerCase();
  } catch {
    return notFound(method, url);
  }

  if (lower === "/" && url.searchParams.get("portal") === "login") {
    // Clean owner login URL. Old links and installed shortcuts keep working.
    const dest = new URL(url.toString());
    dest.protocol = "https:";
    dest.port = "";
    dest.pathname = "/login";
    dest.searchParams.delete("portal");
    return redirect(dest.toString(), 302);
  }
  if (lower === "/" && wantsPortal(url)) {
    return serveSpa(request, env, ctx, method, null, false);
  }

  // /portal?biz= or ?tenant=, and /portal/help, stay on the app. A marketing
  // canonical redirect must not run first: it would drop biz, tenant, dash,
  // demo, and portal. Preview hosts also serve a bare /portal for the sample.
  if (lower === "/portal" || lower.startsWith("/portal/")) {
    return serveSpa(request, env, ctx, method, null, false);
  }

  const page = marketingPage(lower === "" ? "/" : lower);
  if (page) {
    const productionHost = isProductionHost(url.hostname);
    const response = marketingResponse(
      renderMarketingPage(
        page,
        env.BING_SITE_VERIFICATION,
        productionHost ? undefined : { robots: "noindex, nofollow" },
      ),
      method,
      url,
      200,
    );
    if (!productionHost) response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  const spa = classifySpa(stripped);
  if (spa.kind === "spa") {
    if (isHqSpaPath(stripped)) return serveHq(request, env, method);
    return serveSpa(request, env, ctx, method, spa.slug, spa.indexable);
  }

  return notFound(method, url);
}

function notFound(method: string, pageUrl: URL): Response {
  const response = marketingResponse(renderNotFound(), method, pageUrl, 404);
  response.headers.set("X-Robots-Tag", "noindex, follow");
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function apiNotFound(method: string): Response {
  const headers = new Headers();
  applySecurityHeaders(headers, false);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, follow");
  const body = method === "HEAD" ? null : JSON.stringify({ ok: false, error: "not_found" });
  return new Response(body, { status: 404, headers });
}

async function guardStatic(asset: Response | null, pathname: string, method: string): Promise<Response> {
  const fallbackType = STATIC_TYPES[pathname] || "text/plain; charset=utf-8";
  if (!asset) {
    return textResponse("Not found\n", 404, fallbackType, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }, method);
  }
  const type = asset.headers.get("content-type") || "";
  // asset.ok is false for 304 and other 3xx. Those are cache and redirect
  // outcomes and must be returned as-is. 304 is not allowed to carry a body.
  const passthrough = asset.status >= 300 && asset.status < 400;
  if (!passthrough && (!asset.ok || type.includes("text/html"))) {
    await discard(asset);
    return textResponse("Not found\n", 404, fallbackType, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" }, method);
  }
  const headers = new Headers(asset.headers);
  applySecurityHeaders(headers, false);
  if (method === "HEAD" || asset.status === 304) {
    await discard(asset);
    return new Response(null, { status: asset.status, statusText: asset.statusText, headers });
  }
  return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
}

function forceNoindex(html: string): string {
  if (/<meta name="robots" content="[^"]*">/i.test(html)) {
    return html.replace(/<meta name="robots" content="[^"]*">/i, '<meta name="robots" content="noindex, follow">');
  }
  return injectNoindex(html);
}

async function serveSpa(
  request: Request,
  env: SchediEnv,
  ctx: SchediContext,
  method: string,
  slug: string | null,
  indexable: boolean,
): Promise<Response> {
  const booking = !!slug;
  const shell = booking ? await fetchBookingShell(request, env) : await fetchShell(request, env);
  if (!shell || !shell.ok || !(shell.headers.get("content-type") || "").includes("text/html")) {
    if (shell) await discard(shell);
    return textResponse("App shell unavailable\n", 503, "text/plain; charset=utf-8", { "Cache-Control": "no-store" }, method);
  }
  let indexableTenant = indexable;
  let lookup: TenantLookup | null = null;
  if (slug) {
    lookup = await lookupTenant(slug, env, ctx);
    indexableTenant = !!(lookup.tenant && lookup.tenant.seoPublic);
  }
  const raw = method === "HEAD" ? "" : stripPublicShell(await shell.text());
  const bookingTemplate = booking && isBookingDocument(raw);
  let body: string | null = method === "HEAD" ? null : raw;
  if (body != null && bookingTemplate && lookup) {
    if (lookup.missing) {
      body = bookingMissingHtml();
      indexableTenant = false;
    } else if (lookup.paused) {
      body = bookingPausedHtml(lookup.tenant?.name || String(lookup.fields?.name || ""));
      indexableTenant = false;
    } else {
      const pageUrl = new URL(request.url);
      const payHandoff = bookingPayFromSearch(pageUrl.searchParams);
      if (payHandoff.flag === "checkout" && payHandoff.booking && slug) {
        const target = new URL("https://schedi.app/billing/card-pay");
        target.searchParams.set("t", slug);
        target.searchParams.set("b", payHandoff.booking);
        if (payHandoff.kind === "deposit" || payHandoff.kind === "card") target.searchParams.set("kind", payHandoff.kind);
        if (payHandoff.bookings) target.searchParams.set("ids", payHandoff.bookings);
        const payToken = String(pageUrl.searchParams.get("k") || "");
        if (/^[A-Za-z0-9_-]{16,128}$/.test(payToken)) target.searchParams.set("k", payToken);
        const headers = new Headers();
        headers.set("Location", target.toString());
        headers.set("Cache-Control", "no-store");
        headers.set("Referrer-Policy", "no-referrer");
        return new Response(null, { status: 302, headers });
      }
      const canonical = `https://schedi.app/${slug}`;
      body = fillBookingDocument(body, {
        slug: slug || "",
        fields: lookup.fields,
        projectId: env.FIREBASE_PROJECT_ID,
        demo: pageUrl.searchParams.get("demo") === "1",
        jsonLd: lookup.tenant ? localBusinessJsonLd(lookup.tenant, canonical) : null,
        pay: pageUrl.searchParams,
      });
    }
  } else if (body != null && lookup?.tenant && slug) {
    const canonical = `https://schedi.app/${slug}`;
    body = injectBookingMeta(body, {
      name: lookup.tenant.name,
      title: bookingTitle(lookup.tenant.name),
      description: bookingDescription(lookup.tenant.name, lookup.tenant.industry),
      canonical,
    });
    const script = localBusinessScript(lookup.tenant, canonical);
    if (body.includes("</head>")) body = body.replace("</head>", `${script}</head>`);
    else body = script + body;
  }
  if (body != null && !indexableTenant) body = bookingTemplate ? forceNoindex(body) : injectNoindex(body);
  if (body != null) body = injectWebAnalytics(body, new URL(request.url));
  const headers = new Headers(shell.headers);
  applySecurityHeaders(headers, true);
  headers.set("Cache-Control", "no-store");
  headers.delete("Content-Length");
  if (!indexableTenant) headers.set("X-Robots-Tag", "noindex, follow");
  if (method === "GET" && slug && lookup?.tenant && !lookup.missing && !lookup.paused) {
    countPublishedVisit(request, env, slug, lookup.tenant.timezone);
  }
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(body, { status: 200, headers });
}

function countPublishedVisit(request: Request, env: SchediEnv, slug: string, timezone: string | undefined): void {
  const url = new URL(request.url);
  const count = shouldCountBookingVisit({
    method: request.method,
    hostname: url.hostname,
    pathname: url.pathname,
    searchParams: url.searchParams,
    userAgent: request.headers.get("user-agent") || "",
    referer: request.headers.get("referer") || "",
    secFetchDest: request.headers.get("sec-fetch-dest") || "",
    secFetchMode: request.headers.get("sec-fetch-mode") || "",
    secPurpose: request.headers.get("sec-purpose") || request.headers.get("purpose") || "",
  });
  if (!count) return;
  noteBookingVisit(env.PAGE_VISITS, slug, visitDay(new Date(), timezone));
}

function hqDemoRequest(request: Request): boolean {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("demo") !== "1") return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    // Production keeps the agency session gate. The assets-only preview has no KV.
    return host !== "schedi.app" && host !== "www.schedi.app";
  } catch {
    return false;
  }
}

async function serveHq(request: Request, env: SchediEnv, method: string): Promise<Response> {
  const token = agencySessionToken(request);
  const allowed = await requireAgency(env.AUTH_KV, token);
  // Preview only. demo=1 paints sample businesses and the page blocks live calls.
  // It does not create an agency session and does not authorize API routes.
  if (!allowed && !hqDemoRequest(request)) {
    return textResponse(
      injectWebAnalytics(hqLoginDocument(), new URL(request.url)),
      200,
      "text/html; charset=utf-8",
      { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" },
      method,
    );
  }
  const shell = await fetchHqShell(request, env);
  if (!shell || !shell.ok || !(shell.headers.get("content-type") || "").includes("text/html")) {
    if (shell) await discard(shell);
    return textResponse("App shell unavailable\n", 503, "text/plain; charset=utf-8", { "Cache-Control": "no-store" }, method);
  }
  const headers = new Headers(shell.headers);
  applySecurityHeaders(headers, true);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.delete("Content-Length");
  if (method === "HEAD") {
    await discard(shell);
    return new Response(null, { status: 200, headers });
  }
  const body = injectWebAnalytics(await shell.text(), new URL(request.url));
  return new Response(body, { status: 200, headers });
}

export const marketingPaths = publicPaths;
