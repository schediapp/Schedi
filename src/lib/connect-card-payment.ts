import { SchediError } from "./errors";

export interface ConnectCardPaidNotice {
  tenantId: string;
  bookingIds: string[];
  purpose: "card" | "deposit";
  amountCents: number | null;
  paymentIntentId: string;
  splits: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  eventId: string;
}

interface CheckoutLike {
  mode?: string | null;
  payment_status?: string | null;
  amount_total?: number | null;
  payment_intent?: string | { id?: string | null } | null;
  customer?: string | { id?: string | null } | null;
  metadata?: Record<string, string> | null;
}

function bookingIdsFrom(metadata: Record<string, string>): string[] {
  const raw = String(metadata.bookingIds || metadata.schedi_booking_id || "");
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(id) || ids.includes(id)) continue;
    ids.push(id);
    if (ids.length === 12) break;
  }
  return ids;
}

/** Public booking-page charges carry the Firestore tenant id. Local Connect rows do not. */
export function noticeFromCheckoutSession(
  session: CheckoutLike,
  eventId: string,
): ConnectCardPaidNotice | null {
  const metadata = session.metadata || {};
  const tenantId = String(metadata.tenantId || "").trim();
  const bookingIds = bookingIdsFrom(metadata);
  const publicCharge = metadata.schedi_public_booking === "1" || metadata.kind === "booking_payment";
  if (!publicCharge || !tenantId || !bookingIds.length) return null;
  if (session.mode && session.mode !== "payment") return null;
  if (session.payment_status && session.payment_status !== "paid") return null;
  const purpose = metadata.purpose === "deposit" || metadata.charge_kind === "deposit" ? "deposit" : "card";
  const intent = session.payment_intent;
  const paymentIntentId = typeof intent === "string" ? intent : intent?.id || "";
  const customer = session.customer;
  const amount = session.amount_total;
  return {
    tenantId,
    bookingIds,
    purpose,
    amountCents: typeof amount === "number" && Number.isFinite(amount) ? Math.round(amount) : null,
    paymentIntentId,
    splits: String(metadata.splits || ""),
    stripeCustomerId: typeof customer === "string" ? customer : customer?.id || "",
    stripePaymentMethodId: "",
    eventId,
  };
}

export async function recordConnectCardPayment(notice: ConnectCardPaidNotice): Promise<void> {
  const secret = process.env.SCHEDI_CONNECT_PAID_SECRET || "";
  if (!secret) throw new SchediError("SCHEDI_CONNECT_PAID_SECRET is not set.", 500);
  const url = process.env.SCHEDI_CONNECT_PAID_URL || "https://schedi.app/billing/connect-booking-paid";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-schedi-connect-secret": secret,
    },
    body: JSON.stringify(notice),
  });
  if (!response.ok) throw new SchediError("Could not record the card payment.", 502);
}
