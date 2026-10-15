# Schedi

Schedi is booking software for independent businesses. Clients book on a public page. A Pro business can turn on card payments, connect its own Stripe account from the owner portal, and take the client's card payment — including an optional deposit — as a direct charge on that account.

The accepted Connect configuration is in [connect-recommend-plan.md](connect-recommend-plan.md).

- Accounts are created with `/v2/core/accounts`: dashboard `full`, `fees_collector: stripe`, `losses_collector: stripe`, and `configuration.merchant`.
- Charges are direct charges on the connected account. `application_fee_amount` is not set.
- The owner portal embeds `account_onboarding`, `notification_banner`, `account_management`, `payments`, and `payouts`.
- Card checkout and the deposit stay hidden until `configuration.merchant.capabilities.card_payments.status` and `configuration.merchant.capabilities.stripe_balance.payouts.status` are both `active`.
- Owner subscriptions (Free $0, Starter $29/month, Pro $49/month) stay on the Schedi platform account. Schedi reuses one customer per owner and does not pass `customer_account`.
- Plans are month-to-month, with no contract. Cancel anytime. Cancellation takes effect at the end of the current paid billing period; the owner keeps access until then and is not charged again. The Connect app and the public billing handlers set Stripe `cancel_at_period_end=true` and return the period end so the screen can show "Your plan stays active until <date>". Resume clears that flag before the period ends. The public page pauses when Stripe sends `customer.subscription.deleted` at period end, not when the owner requests cancellation. The public SPA posts to `https://schedi.app/billing/cancel` and `/billing/resume`. Those routes are served by the Cloudflare Worker `schedi-email-worker`, whose source is not in this repository (`schedi-web` only forwards `/billing` to static assets). The handlers to mount there are `handleOwnerBillingSchedule` in `src/lib/public-owner-billing.ts`, using the same owner session check as `/billing/checkout`.
- New subscribers may request a full refund of their first payment within 15 days by emailing admin@schedi.app with the business name and the charge date. Renewal payments are not refunded or prorated, except at Schedi's discretion for billing errors or service outages. Complimentary plans are unaffected. This covers Schedi plan fees, not a client's appointment deposit or a payment a business collects from its own customer.
- A failed owner subscription, or one that has ended, pauses the public page. A failed client card does not.
- Cash App, Zelle, Venmo, PayPal, and pay-at-appointment never touch the connected account.

## Run

```bash
npm install
npm test
npm run dev
```

Copy `.env.example` to `.env.local` and set a restricted Stripe key (`rk_`) plus the publishable key before a Pro owner can create a connected account. Forward webhooks to `/api/webhooks/stripe`.

An empty database seeds sample businesses outside production. Sign in at `/portal` as `ava@lumen.studio` to turn on card payments, or open `/b/northwind` to see how card checkout looks when capabilities are already active in sample data. Set `SCHEDI_SEED=0` to start empty. Production does not seed unless `SCHEDI_SEED=1`.

## Production

Card checkout is code-complete and stays hidden until a Pro business has active card payments and payouts. Do not treat cards as live for customers until the Stripe Dashboard setup below is done and one Pro test business completes a card payment.

Only the Dashboard can supply these:

- Finish the Connect platform profile for Schedi.
- Set `STRIPE_SECRET_KEY` and `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (test mode until the smoke test passes).
- Create two webhook destinations, both pointing at `https://<host>/api/webhooks/stripe`:
  - **Your account:** `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Signing secret → `STRIPE_WEBHOOK_SECRET`.
  - **Connected accounts:** `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `payment_intent.payment_failed`. Signing secret → `STRIPE_CONNECT_WEBHOOK_SECRET`.
- Run one Pro test business through onboarding, a deposit, a full card payment, a refund, and a failed owner subscription. The public page pauses only for the subscription failure.

Stripe Tax is not enabled. Client card charges do not set `application_fee_amount`. The app needs a persistent disk for `SCHEDI_DB_PATH`.

## Deploy the public site

`wrangler.jsonc` is the `schedi-web` worker. It serves `site/` as static assets with `run_worker_first`, on `schedi.app/*` and `www.schedi.app/*`. `/api/*` and `/billing/*` stay on their more specific workers. Marketing HTML is rendered in the worker. App and tenant routes use the SPA shell.

Git tracks that shell only. `site/index.html` is a symlink to `../index.html`, which is the file the booking tests read. The rest of the live asset bucket is not in this repository. It lives in the deploy directory production wrangler already uses:

- `assets/` — logos, email marks, the home-screen icon, help-video posters, and help-video mp4s
- `favicon.ico`
- `manifest.json` and `manifest.webmanifest`
- `_headers` — Cloudflare asset headers for that directory. It is not a public URL.

On 13 Oct 2026 the public non-video files the shell references, plus the favicon and both manifests, were about 1.2 MB. The help-video mp4s are separate and larger. That non-video set is under 40 MB, so it stays out of git.

A production deploy assembles the assets directory instead of uploading `site/` from git by itself:

1. Start from the deploy directory that already contains `assets/`, `favicon.ico`, `manifest.json`, `manifest.webmanifest`, and `_headers` next to the shell.
2. Copy `site/index.html` and `site/firebase-messaging-sw.js` from this repo over that directory's copies. Leave the asset bucket in place.
3. Deploy that combined directory with `schedi-web`. Do not replace the bucket with the repo's `site/` folder alone.

## Booking alerts (owner push)

Owners get a pop-up for new and cancelled bookings on the Android app and in web browsers (desktop, Android, and iPhone/iPad once Schedi is on the Home Screen).

- Portal: Email Confirmations tab, "Booking alerts" card, plus a bell button next to Refresh on the roster. The browser code is the `schedi.webPush` script near the end of `index.html`; it stays off inside the Capacitor app, which has its own push code.
- `site/firebase-messaging-sw.js` is the Firebase Cloud Messaging service worker. It is registered with scope `/firebase-cloud-messaging-push-scope`, has no fetch handler, and opens `https://schedi.app/login` when an alert is tapped. It must be deployed next to the shell.
- Firebase web app `1:350589852487:web:c7b4017d8880f0761b0a62` (project `siteforge-97699`). `window.SCHEDI_WEB_PUSH_VAPID_KEY` may hold the public key from Firebase console > Project settings > Cloud Messaging > Web Push certificates; empty uses Firebase's built-in key.
- Server (`workers/schedi-email-worker/src/owner-push.js`): `POST /api/push-token` stores every token in `pushTokens/{business}.tokens` and browser ones also in `webTokens`; web tokens get an FCM `webpush` payload with the Schedi icon and the portal link. Tokens FCM reports as unregistered are pruned. `POST /api/push-test` sends one test alert to the calling device, owner only, once per business per minute.
