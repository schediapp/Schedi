const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,40})$/;
const BOOKING_ID = /^[A-Za-z0-9_-]{4,40}$/;

export type CardPayKind = "deposit" | "card";

/**
 * Short link clients can copy, email, and open later.
 * It stays on schedi.app (no checkout.stripe.com hash that mail clients clip)
 * and the booking page turns it into Stripe Checkout or a buy.stripe.com Payment Link.
 */
export function durableCardPayLink(slug: string, bookingIds: string[], kind: CardPayKind): string {
  const safeSlug = String(slug || "").trim().toLowerCase();
  if (!SLUG.test(safeSlug)) return "";
  const ids: string[] = [];
  for (const raw of bookingIds) {
    const id = String(raw || "").trim();
    if (!BOOKING_ID.test(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length === 12) break;
  }
  if (!ids.length || (kind !== "deposit" && kind !== "card")) return "";

  const url = new URL(`https://schedi.app/${safeSlug}/`);
  url.searchParams.set("pay", "checkout");
  url.searchParams.set("booking", ids[0]!);
  if (ids.length > 1) url.searchParams.set("bookings", ids.slice(1).join(","));
  url.searchParams.set("kind", kind);
  return url.toString();
}

export function isStripePayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      (host === "checkout.stripe.com" || host === "buy.stripe.com" || host === "pay.stripe.com")
    );
  } catch {
    return false;
  }
}

/** Link to show and share. Never the long checkout.stripe.com/c/pay/…#… session URL. */
export function visibleCardPayLink(stripeUrl: string | null | undefined, durable: string): string {
  if (stripeUrl && isStripePayUrl(stripeUrl)) {
    const host = new URL(stripeUrl).hostname.toLowerCase();
    if (host === "buy.stripe.com" || host === "pay.stripe.com") return stripeUrl;
  }
  return durable;
}
