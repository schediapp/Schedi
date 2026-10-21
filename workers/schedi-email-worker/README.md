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
| `SQUARE_APPLICATION_ID` | `npx wrangler secret put SQUARE_APPLICATION_ID` |
| `SQUARE_APPLICATION_SECRET` | `npx wrangler secret put SQUARE_APPLICATION_SECRET` |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | `npx wrangler secret put SQUARE_WEBHOOK_SIGNATURE_KEY` |
| `SQUARE_TOKEN_KEY` | `npx wrangler secret put SQUARE_TOKEN_KEY` (32-byte AES key, base64) |
| `ANALYTICS_API_TOKEN` | `npx wrangler secret put ANALYTICS_API_TOKEN` (Account Analytics Read) |
| `CF_ACCOUNT_ID` | `npx wrangler secret put CF_ACCOUNT_ID` (32-character account id) |

`ANALYTICS_API_TOKEN` and `CF_ACCOUNT_ID` are how Reports reads booking-page visits. Writes happen on `schedi-web` (`PAGE_VISITS` → dataset `schedi_page_visits` in the root `wrangler.jsonc`). The dataset is created the first time a counted view is written. There is no separate dataset create command, and visits are not stored in `AUTH_KV`.

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

## Add an HQ login (`POST /auth/agency-add`)

One-time. Body `{ "email", "password" }`. Requires a live agency session (`X-Schedi-Session`, `schedi_hq` cookie, or JSON `session`) and `Authorization: Bearer <MIGRATION_TOKEN>` (at least 32 characters). Password minimum is 8 characters. The worker calls `ensureAgencySecret`, which writes `AUTH_KV` key `agency:<email>` only when that key has no hash. An existing key is left as it is. Response is `{ "ok": true, "created": true|false }` and does not include the password. It lives under the existing `schedi.app/auth/*` route, so a versions deploy picks it up without a new route entry. The route is 404 on `*.workers.dev`. It is inert until `MIGRATION_TOKEN` is set again (it was removed after the 2026-10-05 migration). Remove the secret after the new login works.

## Inbound admin mail fan-out

`email()` on this worker copies inbound mail for the envelopes in `ADMIN_FORWARD_RECIPIENTS` to every address in `ADMIN_FORWARD_TO` (`message.forward`). Both vars are comma-separated in `wrangler.toml`. A failed forward is logged and the other destinations are still attempted. Any other recipient, including `bookings@schedi.app` and `onboarding@schedi.app` if they were pointed at this worker, is rejected with `message.setReject('Unknown recipient')`.

Email Routing is a dashboard change, not a wrangler route. After deploy: Email Routing → Routing rules → `admin@schedi.app` and `hello@schedi.app` → Action: Send to a Worker → `schedi-email-worker`. Leave the `bookings@` and `onboarding@` rules as they are.

## Owner-private tenant fields (2026-10-05)

Public tenant docs (`artifacts/siteforge-97699/public/data/tenants/{slug}`) are world-readable and hold only what the
booking page needs. Owner contact + billing fields live in `artifacts/siteforge-97699/private/data/tenants/{slug}`,
which Firestore rules deny to every client; only this worker's Admin service account reads/writes it.

- Private keys: `ownerName, ownerEmail, ownerPhone, stripeCustomerId, stripeSubscriptionId, billingExempt,
  complimentaryPro, monthlyPrice, paymentForm, plan, subscriptionStatus`, plus `notifications.replyTo` stored as
  `notificationsReplyTo`. Also private: `signupStartedAt`, `stripeConnectStatus`, `phiAcknowledgment`,
  `ownerIdleTimeoutMin`, and `ownerIdleDefaultApplied`. `stripeConnectReady` stays on the public doc because
  booking pages use it. Source of truth: `src/tenant-private.js` (`PRIVATE_TENANT_KEYS`).
  Payment handles (venmo/zelle/cashapp/paypal) and `notifications.emailConfirmations/extraNote` stay public.
  The public doc also keeps the customer-facing `plan` tier (`free`, `starter`, or `pro`, with complimentary
  shown as `pro`) and `acceptingBookings`. The booking page and the public web worker have no Admin credential,
  so they cannot read the private doc. `subscriptionStatus` is not public. A paused subscription sets
  `acceptingBookings` to false before the status field is removed.
- Browser private keys include `subscriptionStatus` (loaded with `action:"private"`). The portal must not invent
  `subscriptionStatus` from `acceptingBookings`.
- Migration: `node scripts/migrate-tenant-private.mjs --dry-run --fixture tenants.json` plans a local file and
  does not use the network. Production is a separate human step. Dry-run first:
  `POST /api/profile` `{"action":"migrate_private","dryRun":true,"session":"<agency session>"}` with
  `Authorization: Bearer <MIGRATION_TOKEN>`. Apply only after that report looks right, with `"dryRun":false`.
  The worker reads the private doc first and copies only keys that doc does not already have
  (empty string and null count as present and are not overwritten). It verifies the copied values
  and that every field about to be deleted already exists on the private doc, writes `acceptingBookings`,
  then deletes those fields from the public doc. A failed verify does not delete. It does not delete
  the public plan tier. The same copy-only-missing path now includes `signupStartedAt` and
  `stripeConnectStatus`. It does not remove `stripeConnectReady`. The endpoint is inert unless
  `MIGRATION_TOKEN` is set (it was removed after the 2026-10-05 migration).
- Auto log-off: new owners start at 30 minutes. A separate migration moves an existing owner from Off
  or a missing `ownerIdleTimeoutMin` to 30 and sets `ownerIdleDefaultApplied`. 15, 30, and 60 are left
  as chosen. A later Off stays Off because the flag is already set. Owners can still pick Off, 15, 30,
  or 60 afterward. Local dry-run (no network): `node scripts/migrate-owner-idle.mjs --dry-run --fixture tenants.json`.
  Production dry-run: `POST /api/profile` `{"action":"migrate_owner_idle","dryRun":true,"session":"<agency session>"}`
  with `Authorization: Bearer <MIGRATION_TOKEN>`. Apply only after that report, with `"dryRun":false`.
  The response counts are `setTo30`, `leftChosen`, and `alreadyApplied`. Today the timeout is not stored
  on the server, so the first production dry-run counts every tenant as `setTo30`. A browser that already
  chose 15 or 60 writes that choice back once.
- Medical / Healthcare: signup, the owner portal, and HQ require a checkbox before saving that preset.
  The private doc stores `phiAcknowledgment` (`who`, `at`, `version` `phi-ack-v1`). The booking page does not read it.
- Reads: `getTenantById` / `listAllTenants` / ops-snapshot merge the private doc back in, so worker code sees the full tenant.
- Writes: `/api/profile` save, `patchTenantFields` (Stripe webhooks) and signup `createTenantDocument` split the
  object; private keys are merge-written (only keys present). The public doc is rewritten with the effective plan
  tier and `acceptingBookings`, and a status patch deletes `subscriptionStatus` from the public doc. Owners can
  change their own contact fields; billing keys, `plan`, and `subscriptionStatus` are agency/worker-only.
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
- `plan` and `subscriptionStatus` keep their stored values. An owner cannot change them. `subscriptionStatus` is stored on the private doc and removed from the public doc. The public doc is rewritten with the effective plan tier and `acceptingBookings`. `monthlyPrice`, `complimentaryPro`, `billingExempt`, `paymentForm` and the Stripe IDs stay on the private doc.
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

- `POST /api/resend-events` (workers.dev, and `schedi.app/api/resend-events*` for a later move): Resend webhook receiver, Svix-verified with
  `RESEND_WEBHOOK_SECRET`. 503 until the secret is set, 401 on a bad signature. Code: `src/email-events.js`.
- Stores one KV key per event `emailEvt:e:<email_id>:<svix-id>` (metadata only, 180-day TTL); `/api/ops-snapshot` aggregates it
  into `emailEngagement` + `summary.email*`. See `/home/box/agent-data/shared/schedi-ops/README.md` for field meanings.
- Setup that needs the Resend dashboard (our API key is send-only): enable open/click tracking on schedi.app with a tracking
  subdomain (CNAME, DNS-only), create the webhook to the URL above, then
  `XDG_CACHE_HOME=/tmp/wrangler-cache npx -y wrangler@3.114.1 secret put RESEND_WEBHOOK_SECRET`.

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
