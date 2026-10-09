import { SiteHeader } from "@/components/site-header";
import { isPublicPageLive } from "@/lib/readiness";
import { getStore } from "@/lib/store";
import { OWNER_SUBSCRIPTION_POLICY_SHORT } from "@/lib/subscription-policy";
import { PLANS } from "@/lib/types";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const businesses = getStore().listBusinesses();

  return (
    <>
      <SiteHeader />
      <main className="shell">
        <section className="hero">
          <div>
            <p className="eyebrow">Booking for independent businesses</p>
            <h1>Clients book on your page. Card payments land in your Stripe account.</h1>
            <p className="lede">
              Schedi is {formatPlanPrices()}. A Pro business can turn on cards. The charge is created on that
              business&apos;s account, in the business&apos;s name, and Schedi does not take a cut.
            </p>
            <p className="muted" style={{ marginTop: 14 }}>{OWNER_SUBSCRIPTION_POLICY_SHORT}</p>
          </div>
          <div className="panel">
            <h2>Owner portal</h2>
            <p className="muted" style={{ margin: "8px 0 16px" }}>
              Turn on card payments, finish Stripe onboarding, and keep Cash App, Zelle, Venmo, PayPal, and pay-at-appointment alongside cards.
            </p>
            <a className="button" href="/portal">Open the portal</a>
          </div>
        </section>
        <div className="directory">
          {businesses.map((business) => {
            const live = isPublicPageLive(business.subscriptionStatus);
            return (
              <a key={business.id} className="card" href={live ? `/b/${business.slug}` : `/b/${business.slug}`}>
                <div>
                  <strong>{business.name}</strong>
                  <span>{live ? "Public booking page" : "Public page paused"}</span>
                </div>
                <span className="pill">{PLANS[business.plan].name}</span>
              </a>
            );
          })}
        </div>
      </main>
    </>
  );
}

function formatPlanPrices() {
  return `Free, Starter at $29 a month, or Pro at $49 a month`;
}
