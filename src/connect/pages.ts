import { takenSlotTimes } from "../lib/bookings";
import { cardConnectStatus, cardConnectStatusLabel } from "../lib/connect-status";
import { errorMessage } from "../lib/public-origin";
import { formatUsd } from "../lib/money";
import { listPaymentOptions } from "../lib/payment-options";
import { applySchediPlan, fetchSchediPlan, isCardPlanPro, isComplimentaryPro, portalPlanPill } from "../lib/plan-entitlement";
import { isCardCheckoutReady, isPublicPageLive } from "../lib/readiness";
import { formatSlot, upcomingSlots } from "../lib/slots";
import { OWNER_SUBSCRIPTION_POLICY_SHORT, planStaysActiveUntil } from "../lib/subscription-policy";
import { PLANS } from "../lib/types";
import type { Store } from "../lib/db";
import type Stripe from "stripe";
import { fulfillBookingCheckout } from "../lib/bookings";
import { fulfillOwnerCheckout } from "../lib/billing";
import { refreshMerchantCapabilities } from "../lib/connect";
import type { ConnectConfig } from "../lib/connect-config";
import { readCookie, SESSION_COOKIE } from "../lib/session-cookie";
import { CONNECT_DASHBOARD_JS } from "./dashboard-script";
import { PORTAL_CSS } from "./portal-css";

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

export function connectDocument(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${PORTAL_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function header(email?: string | null): string {
  return `<header class="topbar">
  <a class="brand" href="/">Schedi</a>
  <nav>
    ${email ? `<span class="muted">${esc(email)}</span>` : ""}
    <a href="/portal">${email ? "Portal" : "Owner sign in"}</a>
  </nav>
</header>`;
}

function ownerFrom(store: Store, request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return store.getOwnerBySession(token);
}

const SAMPLES = [
  ["ava@lumen.studio", "Ava Chen · Lumen Studio · Pro, cards off"],
  ["nia@harbor.example", "Nia Brooks · Harbor Nails · Pro, cards not active yet"],
  ["leo@northwind.example", "Leo Park · Northwind Cuts · Pro, demo capabilities active"],
  ["sam@fieldwork.example", "Sam Rivera · Fieldwork · Starter"],
  ["rory@paused.example", "Rory Hale · Paused Studio · subscription past due"],
  ["june@freedesk.example", "June Patel · Free Desk · Free"],
];

export function renderSignIn(error?: string, emailSignIn = false): string {
  if (!emailSignIn) {
    return connectDocument(
      "Schedi",
      `${header()}
<main class="shell">
  <section class="panel">
    <p class="eyebrow">Owner portal</p>
    <h1>Sign in from Schedi</h1>
    ${error ? `<p class="banner bad" role="alert">${esc(error)}</p>` : ""}
    <p class="muted">An email address alone does not open this portal. In Schedi, choose Set up Stripe. That link is signed for the signed-in owner and expires in two minutes.</p>
  </section>
</main>`,
    );
  }
  const samples = SAMPLES.map(
    ([email, label]) => `<form method="post" action="/api/session">
      <input type="hidden" name="intent" value="sign-in">
      <input type="hidden" name="email" value="${esc(email)}">
      <button type="submit">${esc(label)}</button>
    </form>`,
  ).join("");
  return connectDocument(
    "Schedi",
    `${header()}
<main class="shell grid-2">
  <form class="panel" method="post" action="/api/session">
    <p class="eyebrow">Owner portal</p>
    <h1>Sign in</h1>
    ${error ? `<p class="banner bad" style="margin-top: 12px" role="alert">${esc(error)}</p>` : ""}
    <input type="hidden" name="intent" value="sign-in">
    <label class="field" style="margin-top: 16px"><span>Email</span><input name="email" type="email" required autocomplete="username"></label>
    <label class="field"><span>Your name</span><input name="owner_name" type="text" autocomplete="name"></label>
    <label class="field"><span>Business name</span><input name="business_name" type="text"></label>
    <p class="muted" style="margin-bottom: 12px">A new email opens a Free page. Name and business are used only the first time.</p>
    <button type="submit">Continue</button>
  </form>
  <section>
    <h2>Sample businesses</h2>
    <div class="sample-list">${samples}</div>
  </section>
</main>`,
  );
}

export async function renderPortal(
  store: Store,
  request: Request,
  stripe: Stripe | null,
  query: URLSearchParams,
  config?: ConnectConfig,
): Promise<string> {
  const frozen = store.maintenance().frozen;
  const owner = ownerFrom(store, request);
  if (!owner) return renderSignIn(query.get("error") || undefined, config ? config.emailSignIn : false);
  const gate = frozen ? false : store.tryAdmit();
  if (gate && query.get("session_id") && stripe) {
    try {
      await fulfillOwnerCheckout(store, stripe, owner, query.get("session_id") || "");
    } catch (error) {
      console.error("Could not finish subscription checkout", error instanceof Error ? error.message : "unknown error");
    }
  }
  const freshOwner = store.getOwner(owner.id);
  const found = store.getBusinessByOwner(freshOwner.id);
  if (!found) {
    if (gate) store.releaseAdmit();
    return renderSignIn("This sign-in has no business.", false);
  }
  let business = found;
  if (gate) {
    const remotePlan = await fetchSchediPlan(
      { slug: found.slug, email: freshOwner.email },
      config ? { connectPaidSecret: config.connectPaidSecret, planUrl: config.planUrl } : undefined,
    );
    business = applySchediPlan(store, found, remotePlan, freshOwner.email);
  }
  if (gate && stripe && business.stripeAccountId) {
    try {
      business = await refreshMerchantCapabilities(store, stripe, business);
    } catch (error) {
      console.error(
        "Could not refresh connected account capabilities:",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
  if (gate) store.releaseAdmit();
  const cardsOpen = isCardPlanPro(business);
  const complimentary = isComplimentaryPro(business);
  const pill = portalPlanPill(business);
  const services = store.listServices(business.id);
  const bookings = store.listBookings(business.id).slice(0, 8);
  const live = isPublicPageLive(business.subscriptionStatus);
  const cardReady = isCardCheckoutReady(business);
  const connectStatus = cardConnectStatus(!!business.stripeAccountId, cardReady);
  const publishableKey = config ? config.publishableKey : process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || "";
  const connectError = query.get("source") === "connect" ? query.get("error") : "";
  const rows = bookings
    .map((booking) => {
      const status =
        booking.status === "payment_failed"
          ? "Card failed"
          : booking.status === "pending_payment"
            ? "Waiting for card"
            : "Confirmed";
      return `<tr>
        <td>${esc(formatSlot(booking.startsAt))}</td>
        <td>${esc(booking.clientName)}</td>
        <td>${esc(booking.paymentMethod)}${booking.chargeKind === "deposit" ? " deposit" : ""} · ${esc(formatUsd(booking.amountCents))}</td>
        <td>${esc(status)}</td>
      </tr>`;
    })
    .join("");
  const subscription = complimentary
    ? `<section class="panel"><h2>Subscription</h2><p class="muted" style="margin: 8px 0 0">Complimentary Pro. Card setup is included, and nothing is billed for the Schedi plan.</p></section>`
    : `<form class="panel" method="post" action="/api/billing">
        <h2>Subscription</h2>
        <p class="muted" style="margin: 8px 0 12px">Owner billing stays on the Schedi Stripe account. Free is ${esc(formatUsd(0))}, Starter is ${esc(formatUsd(2900))}, Pro is ${esc(formatUsd(4900))}.</p>
        <p class="muted" style="margin: 0 0 16px">${esc(OWNER_SUBSCRIPTION_POLICY_SHORT)}</p>
        ${business.cancelAtPeriodEnd && business.currentPeriodEnd ? `<p class="note">${esc(planStaysActiveUntil(business.currentPeriodEnd))}</p>` : ""}
        <div class="actions">
          ${business.plan !== "starter" ? `<button class="secondary" name="plan" value="starter" type="submit">Starter · $29/mo</button>` : ""}
          ${cardsOpen ? `<button class="secondary" name="plan" value="pro" type="submit" disabled>Pro is current</button>` : `<button name="plan" value="pro" type="submit">Pro · $49/mo</button>`}
        </div>
        ${business.cancelAtPeriodEnd && business.stripeSubscriptionId && business.subscriptionStatus !== "canceled" ? `<div style="margin-top: 12px"><button class="secondary" name="plan" value="resume" type="submit">Resume subscription</button></div>` : ""}
        ${!business.cancelAtPeriodEnd && business.stripeSubscriptionId && business.subscriptionStatus !== "canceled" && business.subscriptionStatus !== "none" ? `<div style="margin-top: 12px"><button class="secondary" name="plan" value="cancel" type="submit">Cancel subscription</button></div>` : ""}
      </form>`;
  let cards = "";
  if (!cardsOpen) {
    cards = `<p class="muted" style="margin: 8px 0 12px">Card payments are on an active Pro plan (${esc(formatUsd(PLANS.pro.monthlyCents))} a month). Cash App, Zelle, Venmo, PayPal, and pay-at-appointment stay available on every plan.</p>
      <p class="muted" style="margin: 0 0 16px">${esc(OWNER_SUBSCRIPTION_POLICY_SHORT)}</p>
      <form method="post" action="/api/billing"><input type="hidden" name="plan" value="pro"><button type="submit">Subscribe to Pro</button></form>`;
  } else {
    cards = `<p class="meta" style="margin: 8px 0 12px"><span class="pill">Stripe: ${esc(cardConnectStatusLabel(connectStatus))}</span></p>`;
    if (!business.stripeAccountId) {
      cards += `<p class="muted" style="margin: 8px 0 16px">Set up Stripe to create an account for ${esc(business.name)}. You can leave and come back. Clients pay that account directly, and they do not see card until this is Ready. Stripe bills ${esc(business.name)} for processing. Schedi does not add a fee.</p>
        ${connectError ? `<div class="banner bad" role="alert"><strong>Card payments stayed off.</strong><p>${esc(connectError)}</p><p class="debug-note">${query.get("code") ? `Stripe code ${esc(query.get("code"))}. The server log records the Stripe error type, message, and code on every failed attempt.` : "The server log records this failure on every attempt."}</p></div>` : ""}
        <form method="post" action="/api/connect/enable"><button type="submit">Set up Stripe</button></form>`;
    }
  }
  if (business.stripeAccountId) {
    const widgets = publishableKey
      ? `<div class="connect-stack" id="connect-stack" data-publishable-key="${esc(publishableKey)}"></div><script src="/connect-dashboard.js"></script>`
      : `<p class="banner warn">The connected account exists. Add NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY to load onboarding, the notification banner, account management, payments, and payouts.</p>`;
    cards += `<div id="stripe-setup">
      <p class="muted" style="margin: 8px 0 12px">${cardReady ? `Ready. Clients can pay ${esc(business.name)} by card, including the deposit when it is on.` : "In progress. You can leave and come back to finish. Clients do not see card until this is Ready."}</p>
      <p class="meta"><span class="pill">Card payments: ${esc(business.cardPaymentsStatus ?? "not active")}</span><span class="pill">Payouts: ${esc(business.payoutsStatus ?? "not active")}</span></p>
      <p style="margin-bottom: 16px"><a href="https://dashboard.stripe.com" target="_blank" rel="noreferrer">Open the Stripe Dashboard</a></p>
      ${widgets}
    </div>`;
  }
  return connectDocument(
    business.name,
    `${header(freshOwner.email)}
<main class="shell stack">
  <section>
    <p class="eyebrow">Owner portal</p>
    <h1>${esc(business.name)}</h1>
    <div class="meta">
      <span class="pill">${esc(pill.title)} · ${esc(formatUsd(pill.monthlyCents))}/mo</span>
      <span class="pill">${live ? "Public page is live" : "Public page is paused"}</span>
      <a href="/b/${esc(business.slug)}">View booking page</a>
    </div>
    ${frozen ? `<p class="banner warn">Connect is paused. This page is not taking changes, and an open card checkout finishes only after the pause ends.</p>` : ""}
    ${query.get("error") && query.get("source") !== "connect" ? `<p class="banner bad" role="alert">${esc(query.get("error"))}</p>` : ""}
    ${query.get("updated") ? `<p class="note">Subscription updated.</p>` : ""}
    ${live ? "" : `<p class="banner warn">A failed payment or a subscription that has ended pauses the public page. A failed client card does not.</p>`}
  </section>
  <section class="grid-2">
    <div class="panel"><h2>Card payments</h2>${cards}</div>
    <div class="stack">
      ${subscription}
      <form class="panel" method="post" action="/api/business">
        <h2>Other ways to pay</h2>
        <p class="muted" style="margin: 8px 0 16px">These never touch the connected account.</p>
        <label class="field"><span>Cash App</span><input name="cash_app" type="text" value="${esc(business.cashApp ?? "")}"></label>
        <label class="field"><span>Zelle</span><input name="zelle" type="text" value="${esc(business.zelle ?? "")}"></label>
        <label class="field"><span>Venmo</span><input name="venmo" type="text" value="${esc(business.venmo ?? "")}"></label>
        <label class="field"><span>PayPal</span><input name="paypal" type="text" value="${esc(business.paypal ?? "")}"></label>
        <div class="checks">
          <label><input name="pay_at_appointment" type="checkbox"${business.payAtAppointment ? " checked" : ""}> Pay at the appointment</label>
          <label><input name="deposit_enabled" type="checkbox"${business.depositEnabled ? " checked" : ""}> Offer a card deposit</label>
        </div>
        <label class="field"><span>Deposit amount (USD)</span><input name="deposit_amount" type="number" min="0.50" step="0.01" value="${business.depositAmountCents ? esc((business.depositAmountCents / 100).toFixed(2)) : ""}"></label>
        <button type="submit">Save payment settings</button>
      </form>
    </div>
  </section>
  <section class="panel">
    <h2>Recent bookings</h2>
    ${bookings.length === 0 ? `<p class="muted" style="margin-top: 8px">No bookings yet.</p>` : `<table><thead><tr><th>When</th><th>Client</th><th>Payment</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`}
    ${services.length === 0 ? "" : `<p class="muted" style="margin-top: 12px">${esc(services.map((service) => `${service.name} (${formatUsd(service.priceCents)})`).join(" · "))}</p>`}
    <form method="post" action="/api/session" style="margin-top: 16px"><input type="hidden" name="intent" value="sign-out"><button class="secondary" type="submit">Sign out</button></form>
  </section>
</main>`,
  );
}

export function renderHome(store: Store): string {
  const cards = store
    .listBusinesses()
    .map((business) => {
      const live = isPublicPageLive(business.subscriptionStatus);
      return `<a class="card" href="/b/${esc(business.slug)}"><div><strong>${esc(business.name)}</strong><span>${live ? "Public booking page" : "Public page paused"}</span></div><span class="pill">${esc(PLANS[business.plan].name)}</span></a>`;
    })
    .join("");
  return connectDocument(
    "Schedi",
    `${header()}
<main class="shell">
  <section class="hero">
    <div>
      <p class="eyebrow">Booking for independent businesses</p>
      <h1>Clients book on your page. Card payments land in your Stripe account.</h1>
      <p class="lede">Schedi is Free, Starter at $29 a month, or Pro at $49 a month. A Pro business can turn on cards. The charge is created on that business's account, in the business's name, and Schedi does not take a cut.</p>
      <p class="muted" style="margin-top: 14px">${esc(OWNER_SUBSCRIPTION_POLICY_SHORT)}</p>
    </div>
    <div class="panel">
      <h2>Owner portal</h2>
      <p class="muted" style="margin: 8px 0 16px">Turn on card payments, finish Stripe onboarding, and keep Cash App, Zelle, Venmo, PayPal, and pay-at-appointment alongside cards.</p>
      <a class="button" href="/portal">Open the portal</a>
    </div>
  </section>
  <div class="directory">${cards}</div>
</main>`,
  );
}

export async function renderBooking(
  store: Store,
  stripe: Stripe | null,
  slug: string,
  query: URLSearchParams,
  config?: ConnectConfig,
): Promise<string> {
  const frozen = store.maintenance().frozen;
  const found = store.getBusinessBySlug(slug);
  if (!found) return connectDocument("Schedi", `${header()}<main class="shell"><h1>That page is not here.</h1></main>`);
  let business = found;
  const gate = frozen ? false : store.tryAdmit();
  if (gate && stripe && business.stripeAccountId) {
    try {
      business = await refreshMerchantCapabilities(store, stripe, business);
    } catch (error) {
      console.error(
        "Could not refresh connected account capabilities:",
        error instanceof Error ? error.message : "unknown error",
      );
    }
  }
  if (gate) store.releaseAdmit();
  const services = store.listServices(business.id);
  const live = isPublicPageLive(business.subscriptionStatus);
  const slots = upcomingSlots(new Date(), takenSlotTimes(store, business.id, new Date()));
  const serviceFields = services
    .map(
      (service, index) => `<label class="choice">
        <input type="radio" name="service_id" value="${esc(service.id)}"${index === 0 ? " checked" : ""} required>
        <span>${esc(service.name)}</span>
        <small>${esc(formatUsd(service.priceCents))} · ${esc(service.durationMinutes)} min</small>
      </label>`,
    )
    .join("");
  const slotFields = slots
    .map(
      (slot, index) => `<label class="choice">
        <input type="radio" name="starts_at" value="${esc(slot)}"${index === 0 ? " checked" : ""} required>
        <span>${esc(formatSlot(slot))}</span>
      </label>`,
    )
    .join("");
  const options = services[0] ? listPaymentOptions(business, services[0]) : [];
  const payFields = options
    .map(
      (option, index) => `<label class="choice" data-payment="${esc(option.value)}">
        <input type="radio" name="payment" value="${esc(option.value)}"${index === 0 ? " checked" : ""} required>
        <span>${esc(option.label)}</span>
        <small>${esc(option.detail)}</small>
      </label>`,
    )
    .join("");
  const form = frozen
    ? `<section class="panel"><h2>Paused</h2><p class="muted" style="margin-top: 8px">Connect is paused, so this page is not taking a new booking. A card checkout that is already open can still finish at Stripe. Nothing new is charged here.</p></section>`
    : live
    ? `<form class="panel" method="post" action="/api/bookings">
        <h2>Request a time</h2>
        ${query.get("error") ? `<p class="banner bad">${esc(query.get("error"))}</p>` : ""}
        ${query.get("canceled") ? `<p class="banner warn">The card payment was canceled. The booking was not confirmed.</p>` : ""}
        <input type="hidden" name="slug" value="${esc(business.slug)}">
        <label class="field"><span>Your name</span><input name="client_name" type="text" required autocomplete="name"></label>
        <label class="field"><span>Email</span><input name="client_email" type="email" required autocomplete="email"></label>
        <fieldset><legend>Service</legend>${serviceFields}</fieldset>
        <fieldset><legend>Time</legend>${slotFields}</fieldset>
        <fieldset><legend>How you'll pay ${esc(business.name)}</legend>${payFields}</fieldset>
        <button type="submit">Confirm booking</button>
      </form>`
    : `<section class="panel"><h2>This page is paused</h2><p class="muted" style="margin-top: 8px">${esc(business.name)} is not taking bookings while their Schedi subscription is unpaid or canceled.</p></section>`;
  return connectDocument(
    business.name,
    `${header()}
<main class="shell booking">
  <section>
    <p class="eyebrow">Book with</p>
    <h1>${esc(business.name)}</h1>
    <div class="meta">${services.map((service) => `<span class="pill">${esc(service.name)} · ${esc(service.durationMinutes)} min · ${esc(formatUsd(service.priceCents))}</span>`).join("")}</div>
  </section>
  ${form}
</main>`,
  );
}

function payLabel(method: string): string {
  if (method === "cash_app") return "Cash App";
  if (method === "zelle") return "Zelle";
  if (method === "venmo") return "Venmo";
  if (method === "paypal") return "PayPal";
  return "paying at the appointment";
}

export async function renderBooked(
  store: Store,
  stripe: Stripe | null,
  slug: string,
  bookingId: string,
  config?: ConnectConfig,
): Promise<string> {
  void config;
  const frozen = store.maintenance().frozen;
  const business = store.getBusinessBySlug(slug);
  if (!business || !bookingId) {
    return connectDocument("Schedi", `${header()}<main class="shell"><h1>Booking not found.</h1></main>`);
  }
  let booking;
  try {
    booking = store.getBooking(bookingId);
  } catch {
    booking = null;
  }
  if (!booking || booking.businessId !== business.id) {
    return connectDocument("Schedi", `${header()}<main class="shell"><h1>Booking not found.</h1></main>`);
  }
  if (!frozen && stripe && booking.status === "pending_payment") {
    try {
      booking = await fulfillBookingCheckout(store, stripe, booking);
    } catch (error) {
      console.error("Could not confirm checkout", error instanceof Error ? error.message : "unknown error");
    }
  }
  const service = store.getService(booking.serviceId);
  const remaining = booking.chargeKind === "deposit" ? service.priceCents - booking.amountCents : 0;
  let heading = "";
  if (booking.status === "confirmed") heading = "<h1>You're booked</h1>";
  if (booking.status === "pending_payment") heading = "<h1>Waiting for the card payment</h1>";
  if (booking.status === "payment_failed") heading = "<h1>The card payment did not go through</h1>";
  let note = "";
  if (booking.status === "confirmed" && booking.paymentMethod === "card" && booking.chargeKind === "deposit") {
    note = `<p class="note">${esc(formatUsd(booking.amountCents))} was charged on ${esc(business.name)}'s account. The remaining ${esc(formatUsd(remaining))} is collected in person.</p>`;
  } else if (booking.status === "confirmed" && booking.paymentMethod === "card") {
    note = `<p class="note">${esc(formatUsd(booking.amountCents))} was charged on ${esc(business.name)}'s account.</p>`;
  } else if (booking.status === "confirmed") {
    note = `<p class="note">Pay ${esc(business.name)} by ${esc(payLabel(booking.paymentMethod))}. Nothing was charged on a card.</p>`;
  }
  const banner =
    booking.status === "payment_failed"
      ? `<p class="banner bad">${esc(business.name)}'s page is still open. You can try the card again or choose another way to pay.</p>`
      : booking.status === "pending_payment"
        ? `<p class="banner warn">The booking is confirmed only after the card payment succeeds.</p>`
        : "";
  return connectDocument(
    business.name,
    `${header()}
<main class="shell"><section class="panel">
  <p class="eyebrow">${esc(business.name)}</p>
  ${heading}
  <p class="lede">${esc(service.name)} · ${esc(formatSlot(booking.startsAt))}</p>
  ${note}${banner}
  <p style="margin-top: 16px"><a href="/b/${esc(business.slug)}">Back to ${esc(business.name)}</a></p>
</section></main>`,
  );
}

export function renderHandoff(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>Stripe setup</title>
</head>
<body>
<p>Taking you to Stripe setup…</p>
<script>
(function () {
  var search = new URLSearchParams(location.search);
  var fromQuery = search.get("t");
  if (fromQuery) {
    location.replace(location.pathname + "#t=" + encodeURIComponent(fromQuery));
    return;
  }
  var hash = location.hash || "";
  if (hash.charAt(0) === "#") hash = hash.slice(1);
  var token = hash.slice(0, 2) === "t=" ? hash.slice(2) : "";
  try { token = decodeURIComponent(token); } catch (err) { token = ""; }
  if (!token) {
    location.replace("/portal?error=" + encodeURIComponent("This Stripe setup link is not valid. Nothing was charged."));
    return;
  }
  var form = document.createElement("form");
  form.method = "POST";
  form.action = location.pathname;
  var input = document.createElement("input");
  input.type = "hidden";
  input.name = "t";
  input.value = token;
  form.appendChild(input);
  document.body.appendChild(form);
  history.replaceState(null, "", location.pathname);
  form.submit();
})();
</script>
</body>
</html>`;
}

export function dashboardScript(): string {
  return CONNECT_DASHBOARD_JS;
}

export function pageError(error: unknown): string {
  return errorMessage(error);
}
