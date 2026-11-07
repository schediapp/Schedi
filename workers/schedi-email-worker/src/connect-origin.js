/** Live Railway Connect origin. Cutover sets CONNECT_APP_ORIGIN; until then this stays. */
export const CONNECT_APP_ORIGIN = "https://schedi-connect-production.up.railway.app";

export function connectAppOrigin(env) {
  const configured = String((env && env.CONNECT_APP_ORIGIN) || "").trim().replace(/\/$/, "");
  if (!configured) return CONNECT_APP_ORIGIN;
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return CONNECT_APP_ORIGIN;
    if (url.pathname && url.pathname !== "/") return CONNECT_APP_ORIGIN;
    return url.origin;
  } catch {
    return CONNECT_APP_ORIGIN;
  }
}

export function connectPublicCheckoutUrl(env) {
  return connectAppOrigin(env) + "/api/public-checkout";
}
