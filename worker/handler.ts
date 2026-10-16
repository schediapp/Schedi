// schedi-web request handler.
// Marketing routes are rendered here so crawlers see distinct HTML.
// App and tenant routes keep the SPA shell. Unknown marketing paths are real 404s.

import { marketingPage, publicPaths } from "./content";
import {
  agencySessionToken,
  hasAgencySession,
  HQ_PATHS,
  hqLoginDocument,
  stripPublicShell,
  type AgencyKv,
} from "./public-shell";
import {
  HERO_PATH,
  HERO_SVG,
  renderMarketingBoot,
  renderMarketingTheme,
  THEME_SCRIPT_PATH,
  renderMarketingPage,
  renderNotFound,
  renderRobots,
  renderSitemap,
} from "./render";

export interface AssetFetcher {
  fetch(input: Request): Promise<Response>;
}

export interface SchediEnv {
  ASSETS?: AssetFetcher;
  FIREBASE_PROJECT_ID?: string;
  /** Same AUTH_KV namespace as schedi-email-worker. Required to serve /hq. */
  AUTH_KV?: AgencyKv;
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
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://schedi.app https://schedi-connect-production.up.railway.app https://*.googleapis.com https://*.firebasestorage.app https://*.firebaseio.com wss://*.firebaseio.com",
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
    "manifest-src 'self'",
  ].join("; ");
}

function marketingCsp(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'none'",
    "frame-src 'none'",
    "manifest-src 'self'",
  ].join("; ");
}

export function applySecurityHeaders(headers: Headers, html: boolean): void {
  headers.set("Strict-Transport-Security", "max-age=31536000");
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

function wantsPortal(url: URL): boolean {
  if (stripTrailing(collapse(url.pathname)) !== "/") return false;
  const portal = url.searchParams.get("portal");
  if (portal === "login") return true;
  if (url.searchParams.get("forgot") === "1") return true;
  if (url.searchParams.has("billing")) return true;
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
  if (pathname === "/robots.txt" || pathname === "/sitemap.xml") return false;
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
  const what = industry.replace(/\s+/g, " ").trim() || "Local";
  return `Book an appointment with ${who}. ${what} services with live online scheduling and instant confirmation.`;
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
  if (html.includes('name="robots"')) return html;
  const head = html.indexOf("<head>");
  if (head >= 0) return html.slice(0, head + 6) + tag + html.slice(head + 6);
  return tag + html;
}

type TenantRecord = { name: string; industry: string; slug: string; seoPublic: boolean };

export function tenantFromFirestore(document: unknown): TenantRecord | null {
  if (!document || typeof document !== "object") return null;
  const fields = (document as { fields?: Record<string, Record<string, unknown>> }).fields;
  if (!fields) return null;
  const read = (key: string) => {
    const field = fields[key];
    if (!field || typeof field.stringValue !== "string") return "";
    return field.stringValue;
  };
  const name = read("name").trim();
  if (!name) return null;
  const seo = fields.seoPublic;
  return {
    name,
    industry: read("industry").trim(),
    slug: read("slug").trim().toLowerCase(),
    seoPublic: !!(seo && seo.booleanValue === true),
  };
}

async function lookupTenant(slug: string, env: SchediEnv, ctx: SchediContext): Promise<TenantRecord | null> {
  const projectId = env.FIREBASE_PROJECT_ID || "";
  if (!projectId || !/^[a-z0-9-]+$/i.test(projectId)) return null;
  const endpoint =
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/${projectId}/public/data/tenants/${slug}` +
    `?mask.fieldPaths=name&mask.fieldPaths=industry&mask.fieldPaths=slug&mask.fieldPaths=seoPublic`;
  const cacheKey = new Request(`https://schedi-meta.invalid/tenant/${projectId}/${slug}`);
  try {
    const cached = await cacheMatch(cacheKey);
    if (cached) {
      if (cached.status === 404) return null;
      return (await cached.json()) as TenantRecord;
    }
    const res = await fetch(endpoint);
    if (res.status === 404) {
      await cachePut(
        ctx,
        cacheKey,
        new Response("", { status: 404, headers: { "Cache-Control": "public, max-age=60" } }),
      );
      return null;
    }
    if (!res.ok) {
      console.error(JSON.stringify({ message: "tenant lookup failed", slug, status: res.status }));
      return null;
    }
    const tenant = tenantFromFirestore(await res.json());
    if (!tenant) return null;
    await cachePut(
      ctx,
      cacheKey,
      new Response(JSON.stringify(tenant), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" },
      }),
    );
    return tenant;
  } catch (err) {
    console.error(
      JSON.stringify({
        message: "tenant lookup failed",
        slug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
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

function marketingResponse(html: string, method: string, status = 200): Response {
  const headers = new Headers();
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Security-Policy", marketingCsp());
  headers.set("X-Frame-Options", "DENY");
  headers.set("Cache-Control", "public, max-age=600");
  applySecurityHeaders(headers, false);
  headers.set("Content-Security-Policy", marketingCsp());
  if (method === "HEAD") return new Response(null, { status, headers });
  return new Response(html, { status, headers });
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

export async function handleRequest(request: Request, env: SchediEnv, ctx: SchediContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (isWww(url.hostname)) {
    const dest = new URL(url.toString());
    dest.protocol = "https:";
    dest.hostname = "schedi.app";
    dest.port = "";
    return redirect(dest.toString(), 301);
  }
  if (method !== "GET" && method !== "HEAD") {
    if (isApiOrBilling(url.pathname)) return apiNotFound(method);
    return textResponse("Method not allowed\n", 405, "text/plain; charset=utf-8", { Allow: "GET, HEAD" }, method);
  }

  const collapsed = collapse(url.pathname);
  if (collapsed === "/index.html") {
    const dest = new URL(url.toString());
    dest.protocol = "https:";
    dest.hostname = "schedi.app";
    dest.port = "";
    dest.pathname = "/";
    return redirect(dest.toString(), 308);
  }

  if (collapsed === "/robots.txt") {
    return textResponse(renderRobots(), 200, "text/plain; charset=utf-8", { "Cache-Control": "public, max-age=3600" }, method);
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
    return notFound(method);
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

  const page = marketingPage(lower === "" ? "/" : lower);
  if (page) {
    if (collapsed !== page.path) {
      const dest = new URL(url.toString());
      dest.protocol = "https:";
      dest.hostname = "schedi.app";
      dest.port = "";
      dest.pathname = page.path;
      return redirect(dest.toString(), 301);
    }
    return marketingResponse(renderMarketingPage(page), method, 200);
  }

  const spa = classifySpa(stripped);
  if (spa.kind === "spa") {
    if (isHqSpaPath(stripped)) return serveHq(request, env, method);
    return serveSpa(request, env, ctx, method, spa.slug, spa.indexable);
  }

  return notFound(method);
}

function isWww(hostname: string): boolean {
  return hostname.toLowerCase().replace(/\.+$/, "") === "www.schedi.app";
}

function notFound(method: string): Response {
  const response = marketingResponse(renderNotFound(), method, 404);
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

async function serveSpa(
  request: Request,
  env: SchediEnv,
  ctx: SchediContext,
  method: string,
  slug: string | null,
  indexable: boolean,
): Promise<Response> {
  const shell = await fetchShell(request, env);
  if (!shell || !shell.ok || !(shell.headers.get("content-type") || "").includes("text/html")) {
    if (shell) await discard(shell);
    return textResponse("App shell unavailable\n", 503, "text/plain; charset=utf-8", { "Cache-Control": "no-store" }, method);
  }
  let indexableTenant = indexable;
  let tenant: TenantRecord | null = null;
  if (slug) {
    tenant = await lookupTenant(slug, env, ctx);
    indexableTenant = !!(tenant && tenant.seoPublic);
  }
  let body = method === "HEAD" ? null : stripPublicShell(await shell.text());
  if (body != null && tenant && slug) {
    body = injectBookingMeta(body, {
      name: tenant.name,
      title: bookingTitle(tenant.name),
      description: bookingDescription(tenant.name, tenant.industry),
      canonical: `https://schedi.app/${slug}/`,
    });
  }
  if (body != null && !indexableTenant) body = injectNoindex(body);
  const headers = new Headers(shell.headers);
  applySecurityHeaders(headers, true);
  headers.set("Cache-Control", "no-store");
  headers.delete("Content-Length");
  if (!indexableTenant) headers.set("X-Robots-Tag", "noindex, follow");
  if (method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(body, { status: 200, headers });
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
  const allowed = await hasAgencySession(env.AUTH_KV, token);
  // Preview only. demo=1 paints sample businesses and the page blocks live calls.
  // It does not create an agency session and does not authorize API routes.
  if (!allowed && !hqDemoRequest(request)) {
    return textResponse(
      hqLoginDocument(),
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
  const body = await shell.text();
  return new Response(body, { status: 200, headers });
}

export const marketingPaths = publicPaths;
