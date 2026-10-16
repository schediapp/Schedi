# schedi-email-worker

Cloudflare Worker that accepts the existing SiteForge / Schedi booking-email webhook JSON and sends mail through [Resend](https://resend.com).

**Not deployed yet.** Secrets are Wrangler secrets only — never commit API keys.

## Payload (same as Apps Script)

Browser (`SiteForge.html` → `dispatchTenantMail` / test button) POSTs JSON:

| Field      | Required | Maps to Resend                          |
|------------|----------|-----------------------------------------|
| `to`       | yes      | `to` (string or array)                  |
| `subject`  | yes      | `subject`                               |
| `html`     | html **or** text | `html`                          |
| `text`     | html **or** text | `text`                          |
| `replyTo`  | no       | `reply_to`                              |
| `fromName` | no       | display name in `from` (see below)      |

`from` is built as:

- `"${fromName} via Schedi <bookings@schedi.app>"` when `fromName` is a business / display name
- If `fromName` already contains `via Schedi`, it is not appended again
- If `fromName` is empty or just `Schedi`, use `Schedi <bookings@schedi.app>`

SiteForge today sends `Content-Type: text/plain;charset=utf-8` with a JSON body (legacy Apps Script CORS workaround). This Worker accepts that and `application/json`.

## Auth (required)

Current Apps Script webhook has **no** shared secret. This Worker **requires**:

```http
Authorization: Bearer <WEBHOOK_SECRET>
```

`WEBHOOK_SECRET` must be set as a Wrangler secret. Requests without a matching Bearer token get `401`.

**Before cutting over**, update `SiteForge.html` webhook `fetch` headers to include the Bearer token (and keep CORS-safe origins). Until then, the Worker will reject unauthenticated calls from the current HTML.

Suggested HTML change (do **not** apply until deploy + secrets are ready):

```js
var webhookHeaders = {
  'Content-Type': 'application/json',
  'Authorization': 'Bearer ' + YOUR_WEBHOOK_SECRET_HERE
};
```

Prefer injecting the secret from a build/config step rather than hardcoding a long-lived secret in public HTML if you can; if the Worker is only called from Schedi origins + CORS, a shared Bearer is still a large improvement over the open Apps Script URL. Long-term: move the send behind a server you control so the secret is never in the browser.

## Env bindings

| Name             | How to set                         |
|------------------|------------------------------------|
| `RESEND_API_KEY` | `npx wrangler secret put RESEND_API_KEY` |
| `WEBHOOK_SECRET` | `npx wrangler secret put WEBHOOK_SECRET` |
| `TWILIO_ACCOUNT_SID` | `npx wrangler secret put TWILIO_ACCOUNT_SID` |
| `TWILIO_AUTH_TOKEN` | `npx wrangler secret put TWILIO_AUTH_TOKEN` |
| `TWILIO_FROM` | `npx wrangler secret put TWILIO_FROM` |

Twilio secrets are optional. If any of the three is missing, SMS is skipped and booking/reminder email still sends. Do not put Twilio credentials in HTML. See `/workspace/schedi-sms-twilio-notes.md` for 10DLC.

Placeholders only in repo. For local `wrangler dev`, copy `.dev.vars.example` → `.dev.vars` (gitignored).

## CORS

Allowed `Origin` values:

- `https://schedi.app`
- `https://www.schedi.app`
- `https://schedi.pages.dev`
- `https://*.schedi.pages.dev` (preview branches)

`OPTIONS` preflight returns `204` with `Access-Control-Allow-Methods: POST, OPTIONS` and `Access-Control-Allow-Headers: Content-Type, Authorization`.

## Responses

- `200` `{ "ok": true, "id": "<resend-id>" }`
- `400` validation / bad JSON
- `401` missing or wrong Bearer token
- `405` wrong method
- `5xx` / Resend upstream errors with `{ "ok": false, "error": "..." }`

## Deploy steps (when ready)

1. **Resend**
   - Create API key in Resend dashboard (not in this repo).
   - Verify domain `schedi.app` (or subdomain) and ensure `bookings@schedi.app` is allowed as a From address. Prefer a send subdomain if apex MX is used for Cloudflare Email Routing — see `/workspace/schedi-email-resend-notes.md`.

2. **Install & auth Wrangler**
   ```bash
   cd /workspace/schedi-email-worker
   npm install
   npx wrangler login
   ```

3. **Put secrets**
   ```bash
   npx wrangler secret put RESEND_API_KEY
   npx wrangler secret put WEBHOOK_SECRET
   ```

4. **Deploy**
   ```bash
   npx wrangler deploy
   ```
   Note the `*.workers.dev` URL (e.g. `https://schedi-email-worker.<account>.workers.dev`).

5. **Recommended production URL**
   - Preferred: route on the Schedi zone  
     `https://schedi.app/api/send-booking-email`  
     (Wrangler `routes` / Custom Domains, or Cloudflare Pages Function proxy to the Worker.)
   - Fallback: the `workers.dev` URL above.

   Example `wrangler.toml` route (uncomment and set zone after DNS is ready):

   ```toml
   [[routes]]
   pattern = "schedi.app/api/send-booking-email"
   zone_name = "schedi.app"
   ```

6. **Point SiteForge at the Worker**
   - Set `SITEFORGE_DEFAULT_EMAIL_WEBHOOK` in `SiteForge.html` (and the Agency HQ webhook field / `localStorage` key `siteforge.emailWebhook`) to:
     - `https://schedi.app/api/send-booking-email` **or**
     - `https://schedi-email-worker.<account>.workers.dev`
   - Add `Authorization: Bearer …` on webhook `fetch` calls (see Auth above).
   - Do **not** change the HTML until secrets + deploy are done.

7. **Smoke test**
   ```bash
   curl -sS -X POST 'https://schedi.app/api/send-booking-email' \
     -H 'Content-Type: application/json' \
     -H 'Authorization: Bearer YOUR_WEBHOOK_SECRET' \
     -H 'Origin: https://schedi.app' \
     -d '{"to":"you@example.com","subject":"Schedi worker test","text":"ok","html":"<p>ok</p>","fromName":"Schedi Bookings","replyTo":"you@example.com"}'
   ```
   Expect `{ "ok": true, ... }`.

## Local dev

```bash
cp .dev.vars.example .dev.vars   # fill placeholders
npm install
npx wrangler dev
```

## Do not

- Commit `.dev.vars` or real API keys
- Put `RESEND_API_KEY` or Twilio secrets in HTML or client bundles
- Register a Twilio number from this repo (10DLC is a manual checklist)

## SMS (Twilio)

- **Confirmations:** booking-confirmation webhook (`type: booking_confirmation` plus `sms`) or `action: send_booking_sms`. Worker re-reads tenant `smsEnabled` (default false). Sends only when that flag is true, the booking has a phone, and `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` are all set. Otherwise skips SMS and does not fail the email.
- **Same-day reminders:** hourly cron, same `remindersEnabled` / `reminderHour` gate as email. Also requires `smsEnabled` and a client phone. Dedup field `smsReminderSentAt` on the appointment and on `bookingReminders/{tenantId}__{bookingId}` (email dedup stays `reminderSentAt` / `sentAt`).
- **Copy:** business name, service, date/time. No cancel link.
- One confirmation SMS per booking (`smsConfirmSentAt` on the same reminder doc) so a webhook retry does not double-text.

## Same-day reminder emails (cron)

- **Schedule:** Cloudflare cron `0 * * * *` (hourly). Per tenant, sends only when the local hour in `tenant.timezone` / `tenant.timeZone` (default `America/New_York`) equals `tenant.reminderHour` (default **8**).
- **Opt-out:** skip tenant entirely when `tenant.remindersEnabled === false` (missing/undefined = enabled, matching prior behavior).
- **Source of bookings:** Firestore `artifacts/{FIREBASE_APP_ID}/public/data/tenants/*` → `appointments[]` (same docs the public booking page writes). Access via Firebase **anonymous Auth** + Firestore REST using the public web `FIREBASE_API_KEY` (vars, not secrets).
- **Filters:** appointment `date` equals “today” in the tenant timezone; has `clientEmail`; not cancelled (`status` cancelled/canceled or `cancelled: true`). Cancelled bookings are normally deleted from the array already.
- **Dedup:** skips if `booking.reminderSentAt` is set **or** doc exists at `artifacts/.../bookingReminders/{tenantId}__{bookingId}`. After a successful Resend send, writes the reminder doc and stamps `reminderSentAt` on the appointment.
- **From / Reply-To:** same as booking mail — `{Business} via Schedi <bookings@schedi.app>`, Reply-To owner/`notifications.replyTo`.

### Manual dry-run / force send

```bash
curl -sS -X POST 'https://schedi.app/api/send-booking-email' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_WEBHOOK_SECRET' \
  -d '{"action":"run_reminders","dryRun":true,"force":true}'
```

Omit `dryRun` (or set `false`) to actually send. `force:true` (default for this action) bypasses the per-tenant `reminderHour` gate.


## Ops snapshot (internal, read-only)

`GET|POST https://schedi-email-worker.axl199.workers.dev/api/ops-snapshot` with `Authorization: Bearer <OPS_SNAPSHOT_TOKEN>`
(401 otherwise). Source: `src/ops-snapshot.js`. It makes GET calls only to Firestore and Stripe and sends no email. The hourly cron stores one
snapshot a day at 12:00 UTC in AUTH_KV `opsSnapshot:day:YYYY-MM-DD` (120-day TTL); read it back with `?history=N`.
Consumer docs and the puller script: `/home/box/agent-data/shared/schedi-ops/README.md`.

## Owner-private tenant fields (2026-10-05)

Public tenant docs (`artifacts/siteforge-97699/public/data/tenants/{slug}`) are world-readable and hold only what the
booking page needs. Owner contact + billing fields live in `artifacts/siteforge-97699/private/data/tenants/{slug}`,
which Firestore rules deny to every client; only this worker's Admin service account reads/writes it.

- Private keys: `ownerName, ownerEmail, ownerPhone, stripeCustomerId, stripeSubscriptionId, billingExempt,
  complimentaryPro, monthlyPrice, paymentForm`, plus `notifications.replyTo` stored as `notificationsReplyTo`.
  Source of truth: `src/tenant-private.js` (`PRIVATE_TENANT_KEYS`). Payment handles (venmo/zelle/cashapp/paypal),
  `plan`, `subscriptionStatus`, `notifications.emailConfirmations/extraNote` stay public.
- Reads: `getTenantById` / `listAllTenants` / ops-snapshot merge the private doc back in, so worker code sees the full tenant.
- Writes: `/api/profile` save, `patchTenantFields` (Stripe webhooks) and signup `createTenantDocument` split the
  object; private keys are merge-written (only keys present), the public doc never gets them. Owners can change their
  own contact fields; billing keys are agency/worker-only.
- Browser: signed-in owner/agency load private fields with `POST /api/profile {action:"private", session}` (in memory only).
- Public booking emails: the page sends `ownerTenantId` + `toOwner` / `replyToOwner` / `{{schedi_owner_contact}}`;
  the worker fills the owner's address. Reply-to/contact are only filled when the single recipient is the owner or a
  client with a booking at that business.
- `/billing/status` returns stripe ids only with the owner's/agency session; `/billing/checkout` and `/billing/portal`
  require it. `/billing/subscribe` (email link) no longer pre-fills the owner's email/customer.
- Maintenance: `POST /api/profile {action:"migrate_private", dryRun}` with `Authorization: Bearer <MIGRATION_TOKEN>`
  re-runs the idempotent migration. It is inert unless the `MIGRATION_TOKEN` secret is set (it was removed after the
  2026-10-05 migration). The webhook's `dryRun:true` returns details only with `X-Schedi-Maint: <MIGRATION_TOKEN>`.

## Plan / entitlement lock (2026-10-05)

Owners can't change their plan or billing fields directly. Only these can change them:
- **Stripe** (self-serve): the portal Billing card shows the plan read-only, with Upgrade/Subscribe buttons. They call `POST /billing/checkout` (requires the owner's login session), which creates a Stripe Checkout session. The `checkout.session.completed` / `invoice.paid` webhook sets `plan`, `subscriptionStatus`, `monthlyPrice` and the Stripe IDs once payment succeeds. Creating a checkout changes nothing.
- **Stripe billing portal** ("Manage billing"): card, invoices, cancel (at period end). `customer.subscription.deleted` sets the status to `paused`. Plan switching is turned off in the portal config (`bpc_1ULDvXGh1H5O3dkrbEG83H3f`). Owners switch Starter↔Pro through checkout instead (below).
- **Agency session**: unrestricted via `/api/profile`.

Implemented in `src/entitlements.js`, used by `profile-store.js` (`putTenant`, owner role):
- `plan` and `subscriptionStatus` are always written back with their stored values. `monthlyPrice`, `complimentaryPro`, `billingExempt`, `paymentForm` and the Stripe IDs are dropped.
- The effective plan comes from stored data (complimentaryPro/billingExempt → pro). Below Pro, an owner can't switch ON `allowRecurringBookings`, `paymentGateways.card` or `deposit.enabled`. On Free, they also can't switch on cashapp/zelle/venmo/paypal or add services beyond the stored count (minimum 1). Turning things off is always allowed. The response includes `ignoredFields`.
- An owner save for a tenant with no stored doc returns 404 (it can't create a doc).
- `/api/bookings` `create` (public booking page) rejects recurring bookings (`recurring_pro_only`) and card payments (`card_checkout_pro_only`) below Pro. Deposits and cancellation-fee auto-charge were already Pro-gated server-side.

Checkout rules (`checkoutEligibility`):
- Complimentary tenants → `complimentary_no_charge`.
- No live subscription → Starter or Pro.
- Live subscription on the same plan → 409 `already_subscribed` (use Manage billing).
- Live subscription on the other plan → plan-switch checkout with `metadata[replacesSubscription]`. After the new subscription is paid, the webhook cancels the old one (`prorate=true`, so unused time is credited to the next invoice). The old subscription's `customer.subscription.deleted` is then ignored (`not_current_subscription`).
- `invoice.paid` derives the plan from the price ID first (Starter `price_1UMH8jGh1H5O3dkraHpGvCEN`, Pro `price_1UMH8jGh1H5O3dkr3fNrA90v`), then from metadata.
- `markSubscriptionActive` only touches recurring/card/deposit when the plan actually changes. Renewals keep the owner's payment options.


## Email engagement tracking (Resend webhook), Oct 5, 2026

- `POST /api/resend-events` (workers.dev only, not a schedi.app route): Resend webhook receiver, Svix-verified with
  `RESEND_WEBHOOK_SECRET`. 503 until the secret is set, 401 on a bad signature. Code: `src/email-events.js`.
- Stores one KV key per event `emailEvt:e:<email_id>:<svix-id>` (metadata only, 180-day TTL); `/api/ops-snapshot` aggregates it
  into `emailEngagement` + `summary.email*`. See `/home/box/agent-data/shared/schedi-ops/README.md` for field meanings.
- Setup that needs the Resend dashboard (our API key is send-only): enable open/click tracking on schedi.app with a tracking
  subdomain (CNAME, DNS-only), create the webhook to the URL above, then
  `XDG_CACHE_HOME=/tmp/wrangler-cache npx -y wrangler@3.114.1 secret put RESEND_WEBHOOK_SECRET`.

## Page visits (booking pages)

`POST /api/page-visits` counts one view of a public booking page. `GET /api/page-visits?days=7|30|90` (or `POST` with `{ action: "read", session, days }`) returns that owner's views, approximate uniques, daily series, locations, sources, devices, and browsers. `POST { action: "agency", days }` or `GET ?scope=agency` returns every business. Agency auth matches `/api/ops-snapshot`: an agency session, or `Authorization: Bearer <OPS_SNAPSHOT_TOKEN>`. An owner session on the agency read is 403. There is no new secret.

The beacon sends only the business id, `src`, `utm_source`, and the referrer hostname. It sends no cookie of its own. Bots (user-agent heuristics, and `request.cf.botManagement` when Cloudflare provides it), owner and agency sessions, `?demo=1`, and preview mode are skipped.

### What is stored

Workers Analytics Engine dataset `schedi_page_visits`, one point per counted view:

| Field | Value |
| --- | --- |
| index | business id |
| blobs | UTC day, country, region, city, device, browser, source bucket |
| doubles | 1 view, 1 if this is the first time that visitor was seen today else 0 |

Source buckets are Instagram, Facebook, Google, TikTok, direct, QR (`?src=qr` or `utm_source`), and other. The raw referrer, user agent, and IP are not stored.

Approximate uniques use a daily salt in the existing `AUTH_KV` (`visitSalt:YYYY-MM-DD`, 48 hours). The IP is HMAC'd with that salt and kept only as `visitSeen:{business}:{day}:{hash}` for 36 hours, then the key expires. The hash is not written to Analytics Engine. After the salt expires it cannot be rebuilt. Two visits in the same instant can both be counted as new. That under-counts uniques, it does not identify anyone.

Analytics Engine keeps points for three months, which covers the 7, 30, and 90 day reports. Older days fall off.

`AUTH_KV` also caches whether a business id exists (`visitTenantOk:{id}`) so the beacon does not read Firestore on every view. That cache is not a visit record.

### Bindings Axel adds by deploying this worker

No secret and no new KV namespace. `npx wrangler deploy -c wrangler.toml` from this directory creates:

| Binding | Wrangler | Purpose |
| --- | --- | --- |
| `PAGE_VISITS` | `[[analytics_engine_datasets]]` dataset `schedi_page_visits` | write each view |
| `ANALYTICS_SQL` | `[analytics]` | read the dataset. Needs Wrangler 4.145 or newer |
| `RL_PAGE_VISITS` | rate limit namespace `41007`, 600 per minute per key | beacon cap. The worker also enforces 120 per business per minute in the isolate |
| route | `schedi.app/api/page-visits` | otherwise schedi-web answers `/api/*` with 404 |

Until those bindings exist, the beacon answers `{ ok: true, skipped: "unconfigured" }` and the dashboard read answers 503 `visits_unconfigured`. The public page still loads.

### Cost

Workers Paid includes 10 million Analytics Engine points written per month and 1 million read queries, then $0.25 per extra million writes and $1 per extra million reads. Cloudflare's pricing page (updated April 23, 2026) says this is not billed yet. A dashboard load runs five read queries. Booking-page volume for Schedi stays inside the included amounts.

The seen-set uses the existing `AUTH_KV`: about one read and, for a new visitor, one write per counted view. Paid KV is $0.50 per million reads and $5 per million writes. One hundred thousand visits in a month is well under a dollar.

### Booking and profile allow lists

Visit fields are not written onto bookings or tenant docs, so `BOOKING_KEYS` and the private-tenant key list are unchanged. The beacon only accepts `tenantId`, `src`, `utmSource`, `refHost`, `preview`, and `demo`. Anything else in the JSON is ignored and not stored.

## Deploying from this repo

Run from this directory and name the config explicitly so Wrangler never picks up the repo-root `wrangler.jsonc` (that one is `schedi-web`):

```
npx wrangler deploy -c wrangler.toml
```

Secrets stay in Cloudflare (`wrangler secret put`). Nothing secret is in this directory.

## Owner cancel / resume

`POST /billing/cancel` and `POST /billing/resume` (`src/owner-billing-schedule.js`) take `{ tenantId, session }`.
The session must be the owner of that business (or agency). Complimentary and billing-exempt plans are refused,
and the Stripe subscription's customer must match the stored `stripeCustomerId`. Cancel sets
`cancel_at_period_end=true`; resume clears it only when a cancel is scheduled. Access ends when Stripe sends
`customer.subscription.deleted`. `cancelAtPeriodEnd` / `currentPeriodEnd` are kept on the private tenant doc
and returned by `/billing/status` for a signed-in owner.

`customer.subscription.updated` (cancel or resume done in the Stripe billing portal) saves the same two fields
for the business's current subscription, so the portal shows "Active until" either way. A schedule set with
`cancel_at` only (newer Stripe API versions) counts as a scheduled cancel too. The Stripe webhook endpoint for
`https://schedi.app/billing/webhook` must be subscribed to `customer.subscription.updated` (in addition to
`checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`).

## Owner booking alerts (push)

`src/owner-push.js`. Needs the `FIREBASE_SERVICE_ACCOUNT_JSON` secret.

- `POST /api/push-token` `{action:'register'|'unregister', session, tenantId, token, platform?:'web'|'android'}`. Owner of that business (or agency) only. Keeps up to 20 tokens per business; web tokens are also listed in `webTokens`.
- `POST /api/push-test` `{session, tenantId, token}`. Sends a test alert to that one token if it is registered for the business. One per business per minute (KV `pushtest:{business}`). Route `schedi.app/api/push-test` is in `wrangler.toml`.
- New and cancelled bookings call `sendOwnerPush`. App tokens get the Android payload; web tokens get a `webpush` notification (title, body, `https://schedi.app/assets/homescreen-icon.png`, link `https://schedi.app/login`). UNREGISTERED / NOT_FOUND tokens are pruned.
- Always run wrangler here with `--config ./wrangler.toml`: without it, wrangler can pick up the repo-root `wrangler.jsonc` (`schedi-web`).
