import { NextResponse } from "next/server";
import { SchediError } from "./errors";

export function errorMessage(error: unknown): string {
  if (error instanceof SchediError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/^\[|\]$/g, "").split(":")[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "0.0.0.0";
}

/**
 * Origin the browser can load. Next builds request.url from the bind address
 * (https://localhost:8080 on Railway) unless the host header is trusted.
 * A 303 to that host is a different origin than the public site, and
 * form-action 'self' drops it, so the portal never changes and never shows ?error=.
 */
export function publicOrigin(request: Request): string {
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (railwayDomain && !isLoopbackHost(railwayDomain)) {
    return `https://${railwayDomain}`;
  }

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  if (forwardedHost && !isLoopbackHost(forwardedHost)) {
    const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https";
    return `${proto}://${forwardedHost}`;
  }

  return new URL(request.url).origin;
}

export function redirectTo(request: Request, path: string, params?: Record<string, string | undefined>) {
  const url = new URL(path, `${publicOrigin(request)}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, 303);
}
