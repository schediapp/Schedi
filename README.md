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

`wrangler.jsonc` is the `schedi-web` worker. It serves `site/` as static assets with `run_worker_first`, on `schedi.app/*` and `www.schedi.app/*`. `/api/*` and `/billing/*` stay on their more specific workers, except `POST /api/business-logo` and `GET /logos/*`, which this worker handles. Marketing HTML is rendered in the worker. App and tenant routes use the SPA shell.

Git tracks that shell only. `site/index.html` is a symlink to `../index.html`, which is the file the booking tests read. The rest of the live asset bucket is not in this repository. It lives in the deploy directory production wrangler already uses:

- `assets/` — logos, email marks, the home-screen icon, help-video posters, and help-video mp4s
- `favicon.ico`
- `manifest.json` and `manifest.webmanifest`
- `_headers` — Cloudflare asset headers for that directory. It is not a public URL.

On 13 Oct 2026 the public non-video files the shell references, plus the favicon and both manifests, were about 1.2 MB. The help-video mp4s are separate and larger. That non-video set is under 40 MB, so it stays out of git.

## Preview Worker

Marketing pages and tenant booking pages are the same `schedi-web` Worker (`worker/index.ts`, config `wrangler.jsonc`). There is no separate build step: `npx wrangler deploy` bundles the TypeScript. Do not run a production route attach for a preview.

`env.preview` sets the Worker name to `schedi-web-preview`, turns on `workers.dev`, and sets `"routes": []` so the preview does not inherit `schedi.app` / `www.schedi.app`. Wrangler warns that an environment inherits top-level routes and can hijack those hostnames; the empty `routes` array is the fix.

Assemble assets the same way as production (do not upload git's `site/` folder alone), then:

```bash
npx wrangler deploy --config wrangler.jsonc --env preview
```

The preview hostname stays on `*.workers.dev`. It does not 301 to `https://schedi.app`. Canonical link tags on marketing and tenant pages still point at `https://schedi.app`.

`env.preview.vars.FIREBASE_PROJECT_ID` is `siteforge-97699`, so tenant booking pages can still read public Firestore fields. `env.preview` sets `"kv_namespaces": []` and does not bind `AUTH_KV`. The production id `d53378ec0cfb4d089d73add2ff01c62d` holds live agency sessions, and there is no separate preview namespace. Without `AUTH_KV`, `/hq` cannot save or check an agency session, so the preview shows only the HQ login screen. Logo upload on the preview host also fails closed (`session_required`) for the same reason. Demo mode does not upload.

`env.preview` in `wrangler.jsonc` binds `LOGO_BUCKET` to `schedi-logos-preview` for the `schedi-web-preview` environment. The worker actually used for dashboard previews is `schedi-dashboard-preview`. That config stays out of git. Give it the same `LOGO_BUCKET` → `schedi-logos-preview` binding when R2 is available, or leave the binding off. Do not add a tracked `wrangler.preview.jsonc`, and do not point a preview binding at `schedi-logos`. Create `schedi-logos-preview` before a preview deploy that includes the binding (`npx wrangler r2 bucket create schedi-logos-preview`). If the bucket does not exist yet, delete that environment's `r2_buckets` block. The site still serves, and upload returns `logo_storage_unconfigured`.

Do not set `INDEXNOW_KEY`, `INDEXNOW_ENABLED`, `INDEXNOW_HOST`, or `BING_SITE_VERIFICATION` on the preview Worker. Preview deploys must not ping IndexNow.

## Business logos

Owners upload, replace, and remove a logo on Business profile (new dashboard and `?classic=1`). The browser accepts PNG, JPG, WebP, and SVG up to 2 MB, crops raster files to a square of at most 512 px, and shows a preview before save. SVG is sanitised on the worker (scripts, event handlers, and external references are rejected).

Files live in R2 on `schedi-web`, one object per business: `logos/{tenantId}.{ext}`. Only that business's owner session can write or delete it. The worker serves `https://schedi.app/logos/{tenantId}?v={version}` with `Cache-Control: public, max-age=31536000, immutable` when `v` is present. A replace stores a new `v`, so the old cached URL is left alone. There is no `LOGO_PUBLIC_BASE` and no public r2.dev URL.

Production, before the next `schedi-web` deploy:

```bash
npx wrangler r2 bucket create schedi-logos
```

Binding in `wrangler.jsonc` (top level, not inside `env.preview`):

```jsonc
"r2_buckets": [
  { "binding": "LOGO_BUCKET", "bucket_name": "schedi-logos" }
]
```

No new environment variable and no secret. `AUTH_KV` is the existing owner-session namespace.

R2 is not enabled on the account yet (API error 10042). Leave the `LOGO_BUCKET` binding in `wrangler.jsonc`. Until the binding is present at runtime, `POST /api/business-logo` returns `503 logo_storage_unconfigured` and `GET /logos/...` is a 404. Marketing pages, the owner dashboard, and booking pages still render. Create `schedi-logos` only after R2 is enabled, and before the production deploy. A deploy whose `bucket_name` does not exist fails.

Preview bucket, for `npx wrangler deploy --config wrangler.jsonc --env preview` (`schedi-web-preview`) and for the untracked `schedi-dashboard-preview` config, after R2 is enabled:

```bash
npx wrangler r2 bucket create schedi-logos-preview
```

Binding: `LOGO_BUCKET` → `schedi-logos-preview` on `env.preview` in `wrangler.jsonc`. There is no `wrangler.preview.jsonc` in this repo. If the preview bucket does not exist yet, delete that `r2_buckets` block before deploying the preview environment. Do not point it at `schedi-logos`.

Then deploy `schedi-web` (this repo's `wrangler.jsonc`) only after `schedi-logos` exists. On the next `schedi-email-worker` deploy, its old `schedi.app/api/logo-upload` route is gone so it cannot intercept logo posts. The page calls `POST /api/business-logo` on the same host. `schedi-web` also still accepts `/api/logo-upload` once that email-worker route is removed.

After a save, the owner record stores `logoUrl` and `logo` as the same `https://schedi.app/logos/{tenantId}?v={version}` URL. The dashboard sidebar, the phone header, the classic banner (`?classic=1`), and the public booking header (current design and `?newbook=1`, both the sticky header and the business card) read that URL. With no logo, or if the image fails to load, they show the initials avatar. Booking emails use a status icon (calendar check, reschedule, declined), not a business-logo slot, so those messages stay on that icon.

## IndexNow and Bing

Generate an IndexNow key with `openssl rand -hex 32` (32 to 128 hex characters). Put it on the production Worker only:

```bash
npx wrangler secret put INDEXNOW_KEY
npx wrangler secret put BING_SITE_VERIFICATION
```

Do not commit the key. The production Worker serves it at `https://schedi.app/<key>.txt` when `INDEXNOW_KEY` is set. After a production deploy, or when sitemap URLs change:

```bash
INDEXNOW_ENABLED=true INDEXNOW_HOST=schedi.app INDEXNOW_KEY=<hex> node scripts/indexnow.mjs
```

The script fetches `https://schedi.app/sitemap.xml` and POSTs `{host, key, keyLocation, urlList}` to `https://api.indexnow.org/indexnow`. It exits without a network call unless both the flag and the host are set. `BING_SITE_VERIFICATION` is optional. When it is a safe token, marketing HTML includes `<meta name="msvalidate.01">`. When it is unset, the tag is omitted.

Bing Webmaster Tools: verify `schedi.app` with a DNS CNAME (Cloudflare), the meta tag, or an import from Google Search Console, then submit `https://schedi.app/sitemap.xml`.

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
