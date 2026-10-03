import { SiteHeader } from "@/components/site-header";
import { withFreshCapabilities } from "@/lib/live";
import { formatUsd } from "@/lib/money";
import { listPaymentOptions } from "@/lib/payment-options";
import { isCardCheckoutReady, isPublicPageLive } from "@/lib/readiness";
import { formatSlot, upcomingSlots } from "@/lib/slots";
import { getStore } from "@/lib/store";
import { takenSlotTimes } from "@/lib/bookings";

export const dynamic = "force-dynamic";

export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ error?: string; canceled?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const store = getStore();
  const found = store.getBusinessBySlug(slug);
  if (!found) {
    return (
      <>
        <SiteHeader />
        <main className="shell"><h1>That page is not here.</h1></main>
      </>
    );
  }

  const business = await withFreshCapabilities(found);
  const services = store.listServices(business.id);
  const live = isPublicPageLive(business.subscriptionStatus);
  const cardReady = isCardCheckoutReady(business);
  const slots = upcomingSlots(new Date(), takenSlotTimes(store, business.id, new Date()));

  return (
    <>
      <SiteHeader />
      <main className="shell booking">
        <section>
          <p className="eyebrow">Book with</p>
          <h1>{business.name}</h1>
          <div className="meta">
            {services.map((service) => (
              <span className="pill" key={service.id}>
                {service.name} · {service.durationMinutes} min · {formatUsd(service.priceCents)}
              </span>
            ))}
          </div>
          {live && business.plan === "pro" && !cardReady ? (
            <p className="note">
              Card checkout and the deposit stay off until card payments and payouts are active on {business.name}&apos;s Stripe account.
            </p>
          ) : null}
        </section>

        {!live ? (
          <section className="panel">
            <h2>This page is paused</h2>
            <p className="muted" style={{ marginTop: 8 }}>
              {business.name} is not taking bookings while their Schedi subscription is unpaid or canceled.
            </p>
          </section>
        ) : (
          <form className="panel" method="post" action="/api/bookings">
            <h2>Request a time</h2>
            {query.error ? <p className="banner bad">{query.error}</p> : null}
            {query.canceled ? (
              <p className="banner warn">The card payment was canceled. The booking was not confirmed.</p>
            ) : null}
            <input type="hidden" name="slug" value={business.slug} />
            <label className="field">
              <span>Your name</span>
              <input name="client_name" type="text" required autoComplete="name" />
            </label>
            <label className="field">
              <span>Email</span>
              <input name="client_email" type="email" required autoComplete="email" />
            </label>
            <fieldset>
              <legend>Service</legend>
              {services.map((service, index) => (
                <label className="choice" key={service.id}>
                  <input type="radio" name="service_id" value={service.id} defaultChecked={index === 0} required />
                  <span>{service.name}</span>
                  <small>{formatUsd(service.priceCents)} · {service.durationMinutes} min</small>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Time</legend>
              {slots.map((slot, index) => (
                <label className="choice" key={slot}>
                  <input type="radio" name="starts_at" value={slot} defaultChecked={index === 0} required />
                  <span>{formatSlot(slot)}</span>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>How you&apos;ll pay {business.name}</legend>
              {services[0]
                ? listPaymentOptions(business, services[0]).map((option, index) => (
                    <label className="choice" key={option.value} data-payment={option.value}>
                      <input type="radio" name="payment" value={option.value} defaultChecked={index === 0} required />
                      <span>{option.label}</span>
                      <small>{option.detail}</small>
                    </label>
                  ))
                : null}
            </fieldset>
            <button type="submit">Confirm booking</button>
          </form>
        )}
      </main>
    </>
  );
}
