import type { ConnectConfig } from "./connect-config";
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
 * CONNECT_PUBLIC_ORIGIN wins when it is an https origin, so the Cloudflare
 * host can be set without relying on Railway's domain variable.
 */
export function publicOrigin(request: Request, config?: ConnectConfig): string {
  const configured = (config ? config.publicOrigin : process.env.CONNECT_PUBLIC_ORIGIN)?.trim().replace(/\/$/, "");
  if (configured) {
    try {
      const url = new URL(configured);
      if (
        url.protocol === "https:" &&
        !isLoopbackHost(url.host) &&
        url.pathname === "/" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      ) {
        return url.origin;
      }
    } catch {
      // Fall through to the host the request actually arrived on.
    }
  }

  const railwayDomain = config ? "" : process.env.RAILWAY_PUBLIC_DOMAIN?.trim()
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
