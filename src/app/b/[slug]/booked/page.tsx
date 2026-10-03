import { SiteHeader } from "@/components/site-header";
import { fulfillBookingCheckout } from "@/lib/bookings";
import { formatUsd } from "@/lib/money";
import { formatSlot } from "@/lib/slots";
import { getStore } from "@/lib/store";
import { stripeOrNull } from "@/lib/stripe";

export const dynamic = "force-dynamic";

export default async function BookedPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ booking?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const store = getStore();
  const business = store.getBusinessBySlug(slug);
  if (!business || !query.booking) {
    return (
      <>
        <SiteHeader />
        <main className="shell"><h1>Booking not found.</h1></main>
      </>
    );
  }

  let booking;
  try {
    booking = store.getBooking(query.booking);
  } catch {
    booking = null;
  }
  if (!booking || booking.businessId !== business.id) {
    return (
      <>
        <SiteHeader />
        <main className="shell"><h1>Booking not found.</h1></main>
      </>
    );
  }

  const stripe = stripeOrNull();
  if (stripe && booking.status === "pending_payment") {
    try {
      booking = await fulfillBookingCheckout(store, stripe, booking);
    } catch (error) {
      console.error("Could not confirm checkout", error instanceof Error ? error.message : "unknown error");
    }
  }

  const service = store.getService(booking.serviceId);
  const remaining = booking.chargeKind === "deposit" ? service.priceCents - booking.amountCents : 0;

  return (
    <>
      <SiteHeader />
      <main className="shell">
        <section className="panel">
          <p className="eyebrow">{business.name}</p>
          {booking.status === "confirmed" ? <h1>You&apos;re booked</h1> : null}
          {booking.status === "pending_payment" ? <h1>Waiting for the card payment</h1> : null}
          {booking.status === "payment_failed" ? <h1>The card payment did not go through</h1> : null}
          <p className="lede">
            {service.name} · {formatSlot(booking.startsAt)}
          </p>
          {booking.status === "confirmed" && booking.paymentMethod === "card" && booking.chargeKind === "deposit" ? (
            <p className="note">
              {formatUsd(booking.amountCents)} was charged on {business.name}&apos;s account. The remaining {formatUsd(remaining)} is collected in person.
            </p>
          ) : null}
          {booking.status === "confirmed" && booking.paymentMethod === "card" && booking.chargeKind !== "deposit" ? (
            <p className="note">{formatUsd(booking.amountCents)} was charged on {business.name}&apos;s account.</p>
          ) : null}
          {booking.status === "confirmed" && booking.paymentMethod !== "card" ? (
            <p className="note">Pay {business.name} by {labelFor(booking.paymentMethod)}. Nothing was charged on a card.</p>
          ) : null}
          {booking.status === "payment_failed" ? (
            <p className="banner bad">
              {business.name}&apos;s page is still open. You can try the card again or choose another way to pay.
            </p>
          ) : null}
          {booking.status === "pending_payment" ? (
            <p className="banner warn">The booking is confirmed only after the card payment succeeds.</p>
          ) : null}
          <p style={{ marginTop: 16 }}><a href={`/b/${business.slug}`}>Back to {business.name}</a></p>
        </section>
      </main>
    </>
  );
}

function labelFor(method: string) {
  switch (method) {
    case "cash_app":
      return "Cash App";
    case "zelle":
      return "Zelle";
    case "venmo":
      return "Venmo";
    case "paypal":
      return "PayPal";
    default:
      return "paying at the appointment";
  }
}
