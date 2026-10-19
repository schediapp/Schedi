// One hop to the single public URL.
// Production hosts (schedi.app and www.schedi.app) normalize to https://schedi.app.
// Any other host, including a preview Worker, keeps its own origin.

import { APEX_ORIGIN, marketingPage } from "./content";

const PRODUCTION_HOSTS = new Set(["schedi.app", "www.schedi.app"]);

function collapse(pathname: string): string {
  const collapsed = (pathname || "/").replace(/\/+/g, "/");
  return collapsed || "/";
}

function stripTrailing(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname || "/";
}

function isApiOrBilling(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/") || pathname === "/billing" || pathname.startsWith("/billing/");
}

function isStaticFile(pathname: string): boolean {
  const stripped = stripTrailing(pathname).toLowerCase();
  if (stripped === "/robots.txt" || stripped === "/sitemap.xml" || stripped === "/llms.txt") return false;
  if (pathname === "/favicon.ico" || pathname === "/manifest.json" || pathname === "/manifest.webmanifest") return true;
  if (pathname === "/firebase-messaging-sw.js") return true;
  if (pathname.startsWith("/assets/")) return true;
  const last = pathname.split("/").pop() || "";
  return /\.[a-z0-9]{1,12}$/i.test(last);
}

function rootFunctional(search: string): boolean {
  const params = new URLSearchParams(search);
  if (params.get("portal") === "login") return true;
  if (params.get("forgot") === "1") return true;
  if (params.has("billing")) return true;
  return false;
}

function sameUrl(url: URL, dest: URL): boolean {
  return url.protocol === dest.protocol && url.host === dest.host && url.pathname === dest.pathname && url.search === dest.search;
}

/** Drop utm_*, gclid, fbclid, and ref. Leave every other parameter as it arrived. */
function withoutTracking(search: string): string {
  if (!search) return "";
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  let changed = false;
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || lower === "gclid" || lower === "fbclid" || lower === "ref") {
      params.delete(key);
      changed = true;
    }
  }
  if (!changed) return search.startsWith("?") || search === "" ? search : `?${search}`;
  const next = params.toString();
  return next ? `?${next}` : "";
}

function destination(url: URL, origin: string, pathname: string, search: string): string | null {
  const dest = new URL(origin + pathname);
  dest.search = search;
  if (sameUrl(url, dest)) return null;
  return dest.toString();
}

const DASHBOARD_QUERY = new Set([
  "demo",
  "newdash",
  "newbook",
  "newhq",
  "classic",
  "dash",
  "portal",
  "biz",
  "tenant",
  "forgot",
  "billing",
]);

/**
 * Marketing pages drop tracking and other campaign params.
 * `demo=1` stays. Owner dashboard flags (`newdash`, `newbook`, `newhq`, `classic`, `dash`)
 * stay so a preview link is not redirected off the page that reads it.
 * `/?portal=login`, `/?forgot=1`, and `/?billing=*` keep their full query.
 */
function marketingSearch(url: URL, path: string): string {
  if (path === "/" && rootFunctional(url.search)) return url.search;
  const params = new URLSearchParams(url.search);
  let strippedTracking = false;
  for (const key of [...params.keys()]) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || lower === "gclid" || lower === "fbclid" || lower === "ref") {
      params.delete(key);
      strippedTracking = true;
    }
  }
  const unknown = [...params.keys()].some((key) => !DASHBOARD_QUERY.has(key.toLowerCase()));
  if (unknown) return params.get("demo") === "1" ? "?demo=1" : "";
  if (!strippedTracking) return url.search;
  const next = params.toString();
  return next ? `?${next}` : "";
}

/**
 * Returns the absolute URL to 301 to, or null when the request is already canonical.
 * Marketing pages and the home page drop tracking query params. `demo=1` stays.
 * `/?portal=login`, `/?forgot=1`, and `/?billing=*` keep their full query.
 */
export function publicDuplicateRedirect(url: URL): string | null {
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  const production = PRODUCTION_HOSTS.has(host);
  const origin = production ? APEX_ORIGIN : `${url.protocol}//${url.host}`;
  const collapsed = collapse(url.pathname);
  const noSlash = stripTrailing(collapsed);

  if (/^\/index\.html$/i.test(noSlash)) {
    const search = rootFunctional(url.search) ? url.search : url.searchParams.get("demo") === "1" ? "?demo=1" : "";
    return destination(url, origin, "/", search);
  }

  let decoded = noSlash;
  try {
    decoded = decodeURIComponent(noSlash);
  } catch {
    return null;
  }
  const lookup = decoded.toLowerCase() || "/";
  const first = lookup.split("/").filter(Boolean)[0] || "";
  // /portal and /portal-preview keep their path, including a trailing slash.
  // The owner sign-in redirect runs before this and owns bare /portal.
  if (first === "portal" || first === "portal-preview") {
    return destination(url, origin, collapsed, withoutTracking(url.search));
  }

  const page = marketingPage(lookup);
  if (page) {
    return destination(url, origin, page.path, marketingSearch(url, page.path));
  }

  if (lookup === "/faq") {
    const search = url.searchParams.get("demo") === "1" ? "?demo=1" : "";
    return destination(url, origin, "/help", search);
  }

  if (isStaticFile(collapsed) || isApiOrBilling(collapsed)) {
    return destination(url, origin, collapsed, url.search);
  }

  return destination(url, origin, collapsed, withoutTracking(url.search));
}
