// Business logos are stored on this worker's LOGO_BUCKET binding and served
// from /logos/{tenantId}. Writes use the owner session in AUTH_KV. A missing
// binding fails the upload with logo_storage_unconfigured and leaves the rest
// of the site up. GET of a missing file is a 404 so the page can show initials.

import { handleLogoGet, handleLogoUpload } from "../workers/schedi-email-worker/src/logo-upload.js";
import { readOwnerSession } from "./owner-session";
import type { AgencyKv } from "./public-shell";

export interface LogoBucket {
  put(key: string, value: Uint8Array | ArrayBuffer | string, options?: unknown): Promise<unknown>;
  get?(key: string): Promise<unknown>;
  delete?(key: string): Promise<void>;
}

export interface LogoEnv {
  AUTH_KV?: AgencyKv;
  LOGO_BUCKET?: LogoBucket;
}

function collapse(pathname: string): string {
  const collapsed = (pathname || "/").replace(/\/+/g, "/");
  return collapsed || "/";
}

function logoOriginAllowed(origin: string): boolean {
  if (!origin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "https:") {
    if (host === "schedi.app" || host === "www.schedi.app") return true;
    if (host.endsWith(".workers.dev") || host.endsWith(".schedi.pages.dev")) return true;
    return false;
  }
  if (url.protocol === "http:" && (host === "localhost" || host === "127.0.0.1")) return true;
  return false;
}

function logoJson(body: unknown, status: number, origin: string): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (origin && logoOriginAllowed(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function isLogoApi(pathname: string): boolean {
  return pathname === "/api/business-logo" || pathname === "/api/logo-upload";
}

function isLogoRead(pathname: string): boolean {
  return pathname === "/logos" || pathname.startsWith("/logos/");
}

export async function routeBusinessLogo(request: Request, env: LogoEnv): Promise<Response | null> {
  const url = new URL(request.url);
  const pathname = collapse(url.pathname);
  const method = request.method.toUpperCase();
  if (!isLogoApi(pathname) && !isLogoRead(pathname)) return null;

  if (isLogoRead(pathname)) {
    if (method !== "GET" && method !== "HEAD") {
      return new Response("Method not allowed\n", {
        status: 405,
        headers: { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return handleLogoGet(request, env);
  }

  const origin = request.headers.get("Origin") || "";
  if (method === "OPTIONS") {
    if (origin && !logoOriginAllowed(origin)) return logoJson({ ok: false, error: "origin_not_allowed" }, 403, "");
    const headers = new Headers({
      "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Cache-Control": "no-store",
    });
    if (origin && logoOriginAllowed(origin)) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Vary", "Origin");
    }
    return new Response(null, { status: 204, headers });
  }

  return handleLogoUpload(request, env, origin, {
    json: logoJson,
    isAllowedOrigin: logoOriginAllowed,
    readSession: async (_env: unknown, token: unknown) => readOwnerSession(env.AUTH_KV, String(token || "")),
  });
}
