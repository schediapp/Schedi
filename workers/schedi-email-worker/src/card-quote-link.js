/**
 * Unpriced card bookings: the client asks to pay by card, and the owner later
 * emails a short Stripe Payment Link for the amount they enter.
 * Connect (buy.stripe.com) is tried first, the same way a deposit link is built.
 * A 409 from Connect falls back to the schedi.app pay link. It is not a failure.
 */

export const CARD_LINK_LATER_COPY = "Pay by card: we'll email you a secure payment link once your price is confirmed.";
export const CONNECT_PUBLIC_CHECKOUT = "https://schedi-connect-production.up.railway.app/api/public-checkout";

function roundMoney(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function hasPricedAmount(value) {
  if (value === null || value === undefined || value === "") return false;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0;
}

function findService(services, item) {
  const list = Array.isArray(services) ? services : [];
  const byId = list.find((svc) => svc && item && item.serviceId !== undefined && item.serviceId !== "" && String(svc.id) === String(item.serviceId));
  if (byId) return byId;
  return list.find((svc) => svc && item && svc.name === item.name) || null;
}

/** Catalog dollars for this booking, or null when a service has no price. Ignores booking.amount. */
export function catalogChargeDollars(tenant, booking) {
  const services = Array.isArray(tenant && tenant.services) ? tenant.services : [];
  if (booking && Array.isArray(booking.items) && booking.items.length) {
    let total = 0;
    for (const item of booking.items) {
      const svc = findService(services, item);
      if (!svc || !hasPricedAmount(svc.price)) return null;
      const qty = Math.max(1, Math.min(10, Math.round(Number(item.qty) || 1)));
      total += roundMoney(svc.price) * qty;
    }
    return roundMoney(total);
  }
  const named = services.find((svc) => svc && booking && svc.name === booking.serviceName);
  if (named && hasPricedAmount(named.price)) return roundMoney(named.price);
  return null;
}

/**
 * Dollars the owner stored for an unpriced card booking.
 * A catalog price wins, so a client cannot replace a real service price.
 */
export function ownerQuotedDollars(booking, catalogPrice) {
  if (catalogPrice !== null && catalogPrice !== undefined) return null;
  if (!booking || String(booking.paymentMethod || "").toLowerCase() !== "card") return null;
  const status = String(booking.paymentStatus || "").toUpperCase();
  if (status.indexOf("AWAITING") === -1 || status.indexOf("CARD") === -1) return null;
  if (!hasPricedAmount(booking.amount) || Number(booking.amount) < 0.5) return null;
  return roundMoney(booking.amount);
}

export function quoteAmountCents(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  if (cents < 50 || cents > 1_000_000) return 0;
  return cents;
}

export function awaitingCardQuote(booking) {
  if (!booking || String(booking.paymentMethod || "").toLowerCase() !== "card") return false;
  if (booking.cancelled === true) return false;
  const life = String(booking.status || "").toLowerCase();
  if (life === "denied" || life === "cancelled" || life === "canceled") return false;
  const status = String(booking.paymentStatus || "").toUpperCase();
  if (status.indexOf("PAID") !== -1 && status.indexOf("AWAITING") === -1) return false;
  return status.indexOf("AWAITING CARD LINK") !== -1 || status.indexOf("AWAITING CARD CHECKOUT") !== -1;
}

export function durableQuotedPayLink(slug, bookingId) {
  const safeSlug = String(slug || "").trim().toLowerCase();
  const id = String(bookingId || "").trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(safeSlug)) return "";
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(id)) return "";
  return "https://schedi.app/" + safeSlug + "/?pay=checkout&booking=" + encodeURIComponent(id) + "&kind=card";
}

export function isShortStripePayUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "buy.stripe.com" || host === "pay.stripe.com");
  } catch (_) {
    return false;
  }
}

function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Short Payment Link on the connected account. Any Connect miss, including 409
 * connect_unavailable, keeps the schedi.app link the deposit emails already use.
 */
export async function createQuotedPayLink(fetchImpl, input) {
  const durable = durableQuotedPayLink(input && input.slug, input && input.bookingId);
  if (!durable) return { url: "", via: "", connectStatus: 0 };
  const call = typeof fetchImpl === "function" ? fetchImpl : fetch;
  let status = 0;
  try {
    const res = await call(CONNECT_PUBLIC_CHECKOUT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: input.slug,
        tenantId: input.tenantId,
        bookingIds: [input.bookingId],
        email: input.email || "",
        serviceName: input.serviceName || "Appointment",
        amountCents: input.amountCents,
        chargeKind: "full",
        returnOrigin: "https://schedi.app",
      }),
    });
    status = res && res.status ? res.status : 0;
    const data = await res.json().catch(() => ({}));
    if (res.ok && data && data.mode === "connect" && isShortStripePayUrl(data.url)) {
      return { url: data.url, via: "connect", connectStatus: status };
    }
  } catch (_) {
    status = 0;
  }
  return { url: durable, via: "platform", connectStatus: status };
}

export function quotedPayEmail({ businessName, serviceName, amount, url, when }) {
  const biz = String(businessName || "Schedi");
  const service = String(serviceName || "Appointment");
  const dollars = roundMoney(amount).toFixed(2);
  const link = String(url || "");
  const whenLine = when ? ("When: " + when + "\n") : "";
  const text = [
    "Your price is confirmed.",
    "",
    "Pay $" + dollars + " by card for " + service + " at " + biz + ".",
    whenLine.replace(/\n$/, ""),
    "Secure payment link:",
    link,
    "",
    "Nothing is charged until you open it.",
  ].filter((line) => line !== "").join("\n");
  const href = escapeHtml(link);
  const html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body style=\"margin:0;padding:24px;background:#020617;color:#e2e8f0;font-family:Arial,Helvetica,sans-serif;\">"
    + "<p style=\"font-size:16px;font-weight:700;color:#ffffff;\">Your price is confirmed.</p>"
    + "<p>Pay $" + escapeHtml(dollars) + " by card for " + escapeHtml(service) + " at " + escapeHtml(biz) + ".</p>"
    + (when ? ("<p>" + escapeHtml(when) + "</p>") : "")
    + "<p><a href=\"" + href + "\" style=\"display:inline-block;padding:12px 16px;background:#4f46e5;color:#ffffff;font-weight:700;text-decoration:none;border-radius:12px;\">Pay by card</a></p>"
    + "<p style=\"font-size:12px;color:#94a3b8;\">Or copy this link: " + href + "</p>"
    + "<p style=\"font-size:12px;color:#94a3b8;\">Nothing is charged until you open it.</p>"
    + "</body></html>";
  return {
    subject: "Pay by card \u2014 " + biz,
    text,
    html,
  };
}
