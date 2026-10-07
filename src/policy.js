// Routing and response policy for the Schedi public site.
// Pages/Workers SPA fallbacks must not answer these paths with index.html.

export const APEX_HOST = "schedi.app";
export const WWW_HOST = "www.schedi.app";

export const STATIC_EXACT = {
  "/robots.txt": "text/plain; charset=utf-8",
  "/sitemap.xml": "application/xml; charset=utf-8",
  "/favicon.ico": "image/x-icon",
  "/manifest.json": "application/json; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
};

// First path segment reserved by the client (isReservedBusinessSlug) plus static roots.
const RESERVED_SLUGS = new Set([
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
  "hq-9h7p52",
]);

export function normalizePath(pathname) {
  const raw = pathname || "/";
  const collapsed = raw.replace(/\/+/g, "/");
  if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed || "/";
}

export function isWwwHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.+$/, "");
  return host === WWW_HOST;
}

export function toApexUrl(url) {
  const dest = new URL(url.toString());
  dest.protocol = "https:";
  dest.hostname = APEX_HOST;
  dest.port = "";
  return dest;
}

export function isApiOrBilling(pathname) {
  const path = pathname || "/";
  return path === "/api" || path.startsWith("/api/") || path === "/billing" || path.startsWith("/billing/");
}

export function isAssetPath(pathname) {
  return normalizePath(pathname).startsWith("/assets/");
}

export function hasFileExtension(pathname) {
  const last = normalizePath(pathname).split("/").pop() || "";
  return /\.[a-z0-9]{1,12}$/i.test(last);
}

export function staticContentType(pathname) {
  const path = normalizePath(pathname);
  return STATIC_EXACT[path] || null;
}

export function mustNotHtmlFallback(pathname) {
  const path = normalizePath(pathname);
  if (STATIC_EXACT[path]) return true;
  if (isAssetPath(path)) return true;
  if (hasFileExtension(path)) return true;
  return false;
}

export function bookingSlugFromPath(pathname) {
  const parts = normalizePath(pathname).split("/").filter(Boolean);
  if (!parts.length) return null;
  let first;
  try {
    first = decodeURIComponent(parts[0]).toLowerCase();
  } catch {
    return null;
  }
  if (RESERVED_SLUGS.has(first)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(first)) return null;
  return first;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[ch]));
}

export function bookingDescription(name, industry) {
  const who = String(name || "this business").replace(/\s+/g, " ").trim();
  const what = String(industry || "Local").replace(/\s+/g, " ").trim();
  return `Book an appointment with ${who}. ${what} services with live online scheduling and instant confirmation.`;
}

export function bookingTitle(name) {
  const who = String(name || "Schedi").replace(/\s+/g, " ").trim() || "Schedi";
  return `Book an Appointment | ${who}`;
}

export function canonicalBookingUrl(slug) {
  return `https://${APEX_HOST}/${slug}/`;
}

export function renderBookingHead(meta) {
  const title = escapeHtml(meta.title);
  const description = escapeHtml(meta.description);
  const name = escapeHtml(meta.name);
  const canonical = escapeHtml(meta.canonical);
  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${canonical}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${name}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
  ].join("\n    ");
}

// Replace only the document head title. The app source no longer contains a
// second <title> in the head; this still refuses to edit tags that appear
// after the first script.
export function injectBookingMeta(html, meta) {
  const marker = "<title>Schedi</title>";
  const at = html.indexOf(marker);
  if (at < 0) return html;
  const scriptAt = html.indexOf("<script");
  if (scriptAt !== -1 && at > scriptAt) return html;
  return html.slice(0, at) + renderBookingHead(meta) + html.slice(at + marker.length);
}

export function tenantFromFirestore(document) {
  const fields = document && document.fields;
  if (!fields) return null;
  const read = (key) => {
    const field = fields[key];
    if (!field || typeof field.stringValue !== "string") return "";
    return field.stringValue;
  };
  const name = read("name").trim();
  if (!name) return null;
  return {
    name,
    industry: read("industry").trim(),
    slug: read("slug").trim().toLowerCase(),
  };
}

export function contentSecurityPolicy() {
  // Tailwind's CDN compiler evaluates generated CSS, so script-src keeps
  // 'unsafe-eval'. Inline handlers in the existing page need 'unsafe-inline'.
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
    "connect-src 'self' https://schedi.app https://*.googleapis.com https://*.firebasestorage.app https://*.firebaseio.com wss://*.firebaseio.com",
    "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com",
    "manifest-src 'self'",
  ].join("; ");
}

export function applySecurityHeaders(headers, { html }) {
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  if ((headers.get("Access-Control-Allow-Origin") || "").trim() === "*") {
    headers.delete("Access-Control-Allow-Origin");
  }
  if (html) {
    headers.set("Content-Security-Policy", contentSecurityPolicy());
    headers.set("X-Frame-Options", "DENY");
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  }
}
