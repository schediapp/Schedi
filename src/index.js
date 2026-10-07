import {
  applySecurityHeaders,
  bookingDescription,
  bookingSlugFromPath,
  bookingTitle,
  canonicalBookingUrl,
  injectBookingMeta,
  isApiOrBilling,
  isWwwHost,
  mustNotHtmlFallback,
  staticContentType,
  tenantFromFirestore,
  toApexUrl,
} from "./policy.js";

const SHELL_TITLE = "<title>Schedi</title>";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (isWwwHost(url.hostname)) {
      return redirect(toApexUrl(url), 301);
    }

    if (url.pathname === "/index.html") {
      const dest = new URL(request.url);
      dest.pathname = "/";
      return redirect(dest, 308);
    }

    if (isApiOrBilling(url.pathname)) {
      return passApi(request, env);
    }

    if (mustNotHtmlFallback(url.pathname)) {
      const asset = await env.ASSETS.fetch(request);
      return await guardStatic(asset, url.pathname);
    }

    if (url.pathname === "/" || url.pathname === "") {
      const index = await fetchIndex(request, env);
      return finishHtml(index, request, env, ctx, null);
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.ok || (asset.status >= 300 && asset.status < 400)) {
      if (isHtml(asset)) return finishHtml(asset, request, env, ctx, bookingSlugFromPath(url.pathname));
      return decorate(asset, { html: false });
    }

    const slug = bookingSlugFromPath(url.pathname);
    const spa = request.method === "GET" || request.method === "HEAD";
    if (asset.status === 404 && spa && !mustNotHtmlFallback(url.pathname)) {
      await discard(asset);
      const index = await fetchIndex(request, env);
      return finishHtml(index, request, env, ctx, slug);
    }

    return decorate(asset, { html: isHtml(asset) });
  },
};

function redirect(dest, status) {
  const headers = new Headers();
  applySecurityHeaders(headers, { html: false });
  headers.set("Location", dest.toString());
  headers.set("Cache-Control", "public, max-age=3600");
  return new Response(null, { status, headers });
}

async function passApi(request, env) {
  const asset = await env.ASSETS.fetch(request);
  if (asset.ok || (asset.status >= 300 && asset.status < 400)) {
    return decorate(asset, { html: isHtml(asset) });
  }
  await discard(asset);
  // /api and /billing are served by dedicated workers on more specific routes.
  // If a request reaches this script, do not answer it with the SPA shell.
  const headers = new Headers();
  applySecurityHeaders(headers, { html: false });
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
    status: 404,
    headers,
  });
}

async function guardStatic(asset, pathname) {
  const type = asset.headers.get("content-type") || "";
  if (!asset.ok || type.includes("text/html")) {
    await discard(asset);
    const headers = new Headers();
    applySecurityHeaders(headers, { html: false });
    headers.set("Content-Type", staticContentType(pathname) || "text/plain; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response("Not found\n", { status: 404, headers });
  }
  return decorate(asset, { html: false });
}

async function fetchIndex(request, env) {
  const indexUrl = new URL(request.url);
  indexUrl.pathname = "/index.html";
  indexUrl.search = "";
  const indexRequest = new Request(indexUrl.toString(), { method: "GET" });
  return env.ASSETS.fetch(indexRequest);
}

async function finishHtml(indexResponse, request, env, ctx, slug) {
  if (!indexResponse.ok || !isHtml(indexResponse)) {
    return decorate(indexResponse, { html: isHtml(indexResponse) });
  }
  let body = null;
  if (slug && request.method !== "HEAD") {
    body = await indexResponse.text();
    const tenant = await lookupTenant(slug, env, ctx);
    if (tenant && body.includes(SHELL_TITLE)) {
      body = injectBookingMeta(body, {
        name: tenant.name,
        title: bookingTitle(tenant.name),
        description: bookingDescription(tenant.name, tenant.industry),
        canonical: canonicalBookingUrl(slug),
      });
    }
  }
  const headers = new Headers(indexResponse.headers);
  applySecurityHeaders(headers, { html: true });
  if (body != null) headers.delete("Content-Length");
  const status = indexResponse.status === 200 ? 200 : indexResponse.status;
  if (request.method === "HEAD") {
    return new Response(null, { status, headers });
  }
  if (body != null) return new Response(body, { status, headers });
  return new Response(indexResponse.body, { status, headers });
}

function decorate(response, { html }) {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers, { html });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isHtml(response) {
  return (response.headers.get("content-type") || "").toLowerCase().includes("text/html");
}

async function discard(response) {
  try {
    if (response.body) await response.body.cancel();
  } catch {
    // Already consumed or not cancelable.
  }
}

async function lookupTenant(slug, env, ctx) {
  const projectId = (env && env.FIREBASE_PROJECT_ID) || "";
  if (!projectId || !/^[a-z0-9-]+$/i.test(projectId)) return null;
  const endpoint =
    `https://firestore.googleapis.com/v1/projects/${projectId}` +
    `/databases/(default)/documents/artifacts/${projectId}/public/data/tenants/${slug}` +
    "?mask.fieldPaths=name&mask.fieldPaths=industry&mask.fieldPaths=slug";
  const cacheKey = new Request(`https://schedi-meta.invalid/tenant/${projectId}/${slug}`);
  try {
    const cached = await cacheMatch(cacheKey);
    if (cached) {
      if (cached.status === 404) return null;
      return await cached.json();
    }
    const res = await fetch(endpoint);
    if (res.status === 404) {
      await cachePut(ctx, cacheKey, new Response("", {
        status: 404,
        headers: { "Cache-Control": "public, max-age=60" },
      }));
      return null;
    }
    if (!res.ok) {
      console.error(JSON.stringify({ message: "tenant lookup failed", slug, status: res.status }));
      return null;
    }
    const tenant = tenantFromFirestore(await res.json());
    if (!tenant) return null;
    await cachePut(ctx, cacheKey, new Response(JSON.stringify(tenant), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=120",
      },
    }));
    return tenant;
  } catch (err) {
    console.error(JSON.stringify({
      message: "tenant lookup failed",
      slug,
      error: err instanceof Error ? err.message : String(err),
    }));
    return null;
  }
}

async function cacheMatch(request) {
  try {
    if (typeof caches === "undefined" || !caches || !caches.default) return null;
    return await caches.default.match(request);
  } catch {
    return null;
  }
}

async function cachePut(ctx, request, response) {
  try {
    if (typeof caches === "undefined" || !caches || !caches.default) return;
    const put = caches.default.put(request, response);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(put);
    else await put;
  } catch {
    // Cache is an optimization. A lookup failure still returns the page shell.
  }
}
