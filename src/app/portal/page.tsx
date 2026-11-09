import { ConnectDashboardLoader } from "@/components/connect-dashboard-loader";
import { SiteHeader } from "@/components/site-header";
import { fulfillOwnerCheckout } from "@/lib/billing";
import { currentOwner } from "@/lib/auth";
import { withFreshCapabilities } from "@/lib/live";
import { formatUsd } from "@/lib/money";
import { cardConnectStatus, cardConnectStatusLabel } from "@/lib/connect-status";
import { applySchediPlan, fetchSchediPlan, isCardPlanPro, isComplimentaryPro, portalPlanPill } from "@/lib/plan-entitlement";
import { isCardCheckoutReady, isPublicPageLive } from "@/lib/readiness";
import { formatSlot } from "@/lib/slots";
import { getStore } from "@/lib/store";
import { stripeOrNull } from "@/lib/stripe";
import { OWNER_SUBSCRIPTION_POLICY_SHORT, planStaysActiveUntil } from "@/lib/subscription-policy";
import { PLANS } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; session_id?: string; updated?: string; code?: string; source?: string }>;
}) {
  const query = await searchParams;
  const owner = await currentOwner();
  if (!owner) return <SignIn error={query.error} />;

  const store = getStore();
  const frozen = store.maintenance().frozen;
  const gate = frozen ? false : store.tryAdmit();
  let freshOwner = owner;
  let business = store.getBusinessByOwner(owner.id);
  try {
    if (gate && query.session_id) {
      const stripe = stripeOrNull();
      if (stripe) {
        try {
          await fulfillOwnerCheckout(store, stripe, owner, query.session_id);
        } catch (error) {
          console.error("Could not finish subscription checkout", error instanceof Error ? error.message : "unknown error");
        }
      }
    }
    freshOwner = store.getOwner(owner.id);
    business = store.getBusinessByOwner(freshOwner.id);
    if (business && gate) {
      const remotePlan = await fetchSchediPlan({ slug: business.slug, email: freshOwner.email });
      const entitled = applySchediPlan(store, business, remotePlan, freshOwner.email);
      business = await withFreshCapabilities(entitled);
    }
  } finally {
    if (gate) store.releaseAdmit();
  }
  if (!business) return <SignIn error="This sign-in has no business." />;
  const cardsOpen = isCardPlanPro(business);
  const complimentary = isComplimentaryPro(business);
  const pill = portalPlanPill(business);
  const services = store.listServices(business.id);
  const bookings = store.listBookings(business.id).slice(0, 8);
  const live = isPublicPageLive(business.subscriptionStatus);
  const cardReady = isCardCheckoutReady(business);
  const connectStatus = cardConnectStatus(!!business.stripeAccountId, cardReady);
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  return (
    <>
      <SiteHeader email={freshOwner.email} />
      <main className="shell stack">
        <section>
          <p className="eyebrow">Owner portal</p>
          <h1>{business.name}</h1>
          <div className="meta">
            <span className="pill">{pill.title} · {formatUsd(pill.monthlyCents)}/mo</span>
            <span className="pill">{live ? "Public page is live" : "Public page is paused"}</span>
            <a href={`/b/${business.slug}`}>View booking page</a>
          </div>
          {query.error ? (
            <p className="banner bad" role="alert">{query.error}</p>
          ) : null}
          {query.updated ? <p className="note">Subscription updated.</p> : null}
          {!live ? (
            <p className="banner warn">
              A failed payment or a subscription that has ended pauses the public page. A failed client card does not.
            </p>
          ) : null}
        </section>

        <section className="grid-2">
          <div className="panel">
            <h2>Card payments</h2>
            {!cardsOpen ? (
              <>
                <p className="muted" style={{ margin: "8px 0 12px" }}>
                  Card payments are on an active Pro plan ({formatUsd(PLANS.pro.monthlyCents)} a month). Cash App, Zelle, Venmo, PayPal, and pay-at-appointment stay available on every plan.
                </p>
                <p className="muted" style={{ margin: "0 0 16px" }}>{OWNER_SUBSCRIPTION_POLICY_SHORT}</p>
                <form method="post" action="/api/billing">
                  <input type="hidden" name="plan" value="pro" />
                  <button type="submit">Subscribe to Pro</button>
                </form>
              </>
            ) : null}

            {cardsOpen ? (
              <p className="meta" style={{ margin: "8px 0 12px" }}>
                <span className="pill">Stripe: {cardConnectStatusLabel(connectStatus)}</span>
              </p>
            ) : null}

            {cardsOpen && !business.stripeAccountId ? (
              <>
                <p className="muted" style={{ margin: "8px 0 16px" }}>
                  Set up Stripe to create an account for {business.name}. You can leave and come back. Clients pay that account directly, and they do not see card until this is Ready. Stripe bills {business.name} for processing. Schedi does not add a fee.
                </p>
                {query.source === "connect" && query.error ? (
                  <div className="banner bad" role="alert">
                    <strong>Card payments stayed off.</strong>
                    <p>{query.error}</p>
                    <p className="debug-note">
                      {query.code
                        ? `Stripe code ${query.code}. The server log records the Stripe error type, message, and code on every failed attempt.`
                        : "The server log records this failure on every attempt."}
                    </p>
                  </div>
                ) : null}
                <form method="post" action="/api/connect/enable">
                  <button type="submit">Set up Stripe</button>
                </form>
              </>
            ) : null}

            {business.stripeAccountId ? (
              <div id="stripe-setup">
                <p className="muted" style={{ margin: "8px 0 12px" }}>
                  {cardReady
                    ? `Ready. Clients can pay ${business.name} by card, including the deposit when it is on.`
                    : "In progress. You can leave and come back to finish. Clients do not see card until this is Ready."}
                </p>
                <p className="meta">
                  <span className="pill">Card payments: {business.cardPaymentsStatus ?? "not active"}</span>
                  <span className="pill">Payouts: {business.payoutsStatus ?? "not active"}</span>
                </p>
                <p style={{ marginBottom: 16 }}>
                  <a href="https://dashboard.stripe.com" target="_blank" rel="noreferrer">Open the Stripe Dashboard</a>
                </p>
                {publishableKey ? (
                  <ConnectDashboardLoader publishableKey={publishableKey} />
                ) : (
                  <p className="banner warn">
                    The connected account exists. Add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to load onboarding, the notification banner, account management, payments, and payouts.
                  </p>
                )}
              </div>
            ) : null}
          </div>

          <div className="stack">
            {complimentary ? (
              <section className="panel">
                <h2>Subscription</h2>
                <p className="muted" style={{ margin: "8px 0 0" }}>
                  Complimentary Pro. Card setup is included, and nothing is billed for the Schedi plan.
                </p>
              </section>
            ) : (
            <form className="panel" method="post" action="/api/billing">
              <h2>Subscription</h2>
              <p className="muted" style={{ margin: "8px 0 12px" }}>
                Owner billing stays on the Schedi Stripe account. Free is {formatUsd(0)}, Starter is {formatUsd(2900)}, Pro is {formatUsd(4900)}.
              </p>
              <p className="muted" style={{ margin: "0 0 16px" }}>{OWNER_SUBSCRIPTION_POLICY_SHORT}</p>
              {business.cancelAtPeriodEnd && business.currentPeriodEnd ? (
                <p className="note">{planStaysActiveUntil(business.currentPeriodEnd)}</p>
              ) : null}
              <div className="actions">
                {business.plan !== "starter" ? (
                  <button className="secondary" name="plan" value="starter" type="submit">Starter · $29/mo</button>
                ) : null}
                {!cardsOpen ? (
                  <button name="plan" value="pro" type="submit">Pro · $49/mo</button>
                ) : (
                  <button className="secondary" name="plan" value="pro" type="submit" disabled>Pro is current</button>
                )}
              </div>
              {business.cancelAtPeriodEnd && business.stripeSubscriptionId && business.subscriptionStatus !== "canceled" ? (
                <div style={{ marginTop: 12 }}>
                  <button className="secondary" name="plan" value="resume" type="submit">Resume subscription</button>
                </div>
              ) : null}
              {!business.cancelAtPeriodEnd && business.stripeSubscriptionId && business.subscriptionStatus !== "canceled" && business.subscriptionStatus !== "none" ? (
                <div style={{ marginTop: 12 }}>
                  <button className="secondary" name="plan" value="cancel" type="submit">Cancel subscription</button>
                </div>
              ) : null}
            </form>
            )}

            <form className="panel" method="post" action="/api/business">
              <h2>Other ways to pay</h2>
              <p className="muted" style={{ margin: "8px 0 16px" }}>
                These never touch the connected account.
              </p>
              <label className="field">
                <span>Cash App</span>
                <input name="cash_app" type="text" defaultValue={business.cashApp ?? ""} />
              </label>
              <label className="field">
                <span>Zelle</span>
                <input name="zelle" type="text" defaultValue={business.zelle ?? ""} />
              </label>
              <label className="field">
                <span>Venmo</span>
                <input name="venmo" type="text" defaultValue={business.venmo ?? ""} />
              </label>
              <label className="field">
                <span>PayPal</span>
                <input name="paypal" type="text" defaultValue={business.paypal ?? ""} />
              </label>
              <div className="checks">
                <label>
                  <input name="pay_at_appointment" type="checkbox" defaultChecked={business.payAtAppointment} />
                  Pay at the appointment
                </label>
                <label>
                  <input name="deposit_enabled" type="checkbox" defaultChecked={business.depositEnabled} />
                  Offer a card deposit
                </label>
              </div>
              <label className="field">
                <span>Deposit amount (USD)</span>
                <input
                  name="deposit_amount"
                  type="number"
                  min="0.50"
                  step="0.01"
                  defaultValue={business.depositAmountCents ? (business.depositAmountCents / 100).toFixed(2) : ""}
                />
              </label>
              <button type="submit">Save payment settings</button>
            </form>
          </div>
        </section>

        <section className="panel">
          <h2>Recent bookings</h2>
          {bookings.length === 0 ? <p className="muted" style={{ marginTop: 8 }}>No bookings yet.</p> : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Client</th>
                  <th>Payment</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {bookings.map((booking) => (
                  <tr key={booking.id}>
                    <td>{formatSlot(booking.startsAt)}</td>
                    <td>{booking.clientName}</td>
                    <td>{booking.paymentMethod}{booking.chargeKind === "deposit" ? " deposit" : ""} · {formatUsd(booking.amountCents)}</td>
                    <td>{booking.status === "payment_failed" ? "Card failed" : booking.status === "pending_payment" ? "Waiting for card" : "Confirmed"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {services.length === 0 ? null : (
            <p className="muted" style={{ marginTop: 12 }}>
              {services.map((service) => `${service.name} (${formatUsd(service.priceCents)})`).join(" · ")}
            </p>
          )}
          <form method="post" action="/api/session" style={{ marginTop: 16 }}>
            <input type="hidden" name="intent" value="sign-out" />
            <button className="secondary" type="submit">Sign out</button>
          </form>
        </section>
      </main>
    </>
  );
}

function SignIn({ error }: { error?: string }) {
  return (
    <>
      <SiteHeader />
      <main className="shell">
        <section className="panel">
          <p className="eyebrow">Owner portal</p>
          <h1>Sign in from Schedi</h1>
          {error ? <p className="banner bad" style={{ marginTop: 12 }} role="alert">{error}</p> : null}
          <p className="muted" style={{ marginTop: 12 }}>
            An email address alone does not open this portal. In Schedi, choose Set up Stripe. That link is signed for the signed-in owner.
          </p>
        </section>
      </main>
    </>
  );
}
