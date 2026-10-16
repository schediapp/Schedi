// Cloudflare Web Analytics. The token is a public site token from the dashboard.
export const WEB_ANALYTICS_TOKEN = "0dd8dc6f9fab4de484d8c5f5a1f1a57e";

export const WEB_ANALYTICS_SCRIPT_ORIGIN = "https://static.cloudflareinsights.com";

export const WEB_ANALYTICS_CONNECT_ORIGIN = "https://cloudflareinsights.com";

export const PREVIEW_ANALYTICS_HOST = "schedi-dashboard-preview.axl199.workers.dev";

export const WEB_ANALYTICS_SNIPPET =
  `<!-- Cloudflare Web Analytics --><script type='module' src='${WEB_ANALYTICS_SCRIPT_ORIGIN}/beacon.min.js' data-cf-beacon='{"token": "${WEB_ANALYTICS_TOKEN}"}'></script><!-- End Cloudflare Web Analytics -->`;

export function shouldLoadWebAnalytics(url: URL): boolean {
  if (url.hostname.toLowerCase() === PREVIEW_ANALYTICS_HOST) return false;
  return url.searchParams.get("demo") !== "1";
}

/** Insert the dashboard snippet immediately before the document's closing body tag. */
export function injectWebAnalytics(html: string, url: URL): string {
  if (!html || !shouldLoadWebAnalytics(url)) return html;
  const close = html.lastIndexOf("</body>");
  if (close < 0) return html;
  return html.slice(0, close) + WEB_ANALYTICS_SNIPPET + html.slice(close);
}
