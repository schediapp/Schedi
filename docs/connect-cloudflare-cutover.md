# Connect app: Railway to Cloudflare

This is the cutover runbook for `schedi-connect`. It does not change Stripe, DNS, or the live Railway service. Those steps stay with the parent operator. Do not print secret values. Do not deploy `schedi-web` from git's `site/` folder; the live asset bucket is assembled beside the shell, and production was restored to version `390425bc-78d1-4486-9aca-086675668cb0` after an incomplete upload.

## What Railway still owns

Deployed commit `d15d2883d0a508bba23475c09c614b8db25e5f8b` is an ancestor of `main`. Connect behavior since that deploy is additive (force-park, SQLite download, a few Connect columns). The service is the Next.js app at the repository root. Railpack builds that app. There is no separate app root.

Railway serves the owner portal (`/`, `/portal`), Connect handoff (`/api/connect/handoff`), embedded Stripe components (`/api/connect/session`, `/api/connect/enable`), owner billing and sessions (`/api/billing`, `/api/session`, `/api/business`), the Connect booking pages (`/b/:slug`, `/api/bookings`), public card checkout (`/api/public-checkout`), both Stripe webhook deliveries (`POST /api/webhooks/stripe`), and the admin routes. Callers:

- Stripe `we_1UUoCdGh1H5O3dkrdjlgftlc` and `we_1UUoCdGh1H5O3dkrW95roxaF`, both enabled, both `https://schedi-connect-production.up.railway.app/api/webhooks/stripe`.
- `schedi.app` booking pages and `schedi-email-worker` `POST` public checkout on that host. Default stays the Railway URL until `CONNECT_APP_ORIGIN` is set.
- Owner "Set up Stripe" goes `schedi.app/billing/connect-handoff` then to Railway `/api/connect/handoff#t=...`. The token is in the fragment, then a form body.
- `worker/handler.ts` CSP `connect-src` allows the Railway host. `site/index.html`, `site/booking.html`, and `site/hq.html` still contain the Railway checkout or portal URL.

`schedi.app/billing/webhook` (`we_1UUpRdGh1H5O3dkrpDBcw8hL`) is the email worker. It updates Firestore owner billing and public booking payment. It is not a Railway substitute. Keep it. Railway's copy of owner subscription state only drives the Connect portal and `/b/:slug` pages. A connected-account event (`event.account` set) never pauses that page. A platform `invoice.payment_failed` or `customer.subscription.deleted` does. `invoice.paid` is handled only on `schedi.app`.

The database is one SQLite file at `SCHEDI_DB_PATH` (production volume `/data`, 500 MB). Tables: `owners`, `businesses`, `services`, `bookings`, `sessions`, `stripe_events`, `connect_handoffs`. Writes are single statements. There is no second database service. `SESSION_SECRET` is set on Railway and is not read by the app. The session is the random `sessions.token` cookie.

## Cloudflare shape

`workers/schedi-connect` is a Worker with one Durable Object, `ConnectDatabase`, name `schedi-connect`. Durable Object SQLite is the store because the schema is already SQLite, the access is synchronous, and one object keeps the single writer the file has today. D1 would make every store call async and would spread writes across isolates. The Worker has **no routes**. It must not be given `schedi.app/*` or `www.schedi.app/*`.

`wrangler.jsonc` sets `NODE_ENV=production` and `SCHEDI_SEED=0`. An empty database must not grow the demo businesses. Secrets, set with `wrangler secret put` and never committed:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET` (platform endpoint)
- `STRIPE_CONNECT_WEBHOOK_SECRET` (connected-account endpoint)
- `SCHEDI_CONNECT_PAID_SECRET` (same value the email worker already uses)
- `STRIPE_PRICE_STARTER`
- `STRIPE_PRICE_PRO`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

Optional: `CONNECT_PUBLIC_ORIGIN` (https origin only), `SCHEDI_CONNECT_PAID_URL`, `SCHEDI_CONNECT_READY_URL`, `SCHEDI_PLAN_URL`. Defaults remain `https://schedi.app/billing/connect-booking-paid`, `/billing/connect-ready`, and `/billing/connect-plan`.

Webhook checks use the raw body and either signing secret. A completed event id is not applied again. A delivery that throws is not marked done, so Stripe's retry still applies it. A second delivery that arrives while the first is in flight gets HTTP 500 and does not repeat the side effect. A processing row older than two minutes can be taken over after a crash.

## Backup and restore

Do this against a local file or the admin endpoint. Do not paste the body into chat. It contains owner emails, client names, and session tokens.

1. Deploy the snapshot route to Railway only after this branch is the intended Railway release. `GET /api/admin/sqlite-snapshot` with header `x-schedi-connect-secret` takes `BEGIN IMMEDIATE` and returns `schedi-connect-snapshot-v1` JSON. That is the consistent export. The older `GET /api/admin/sqlite-download` is a raw file read and can tear if a write is in progress.
2. On the downloaded JSON, or on a quiescent SQLite file (not a live WAL copy):

```bash
npm run connect:snapshot -- verify data/schedi.sqlite
npm run connect:snapshot -- export data/schedi.sqlite /tmp/schedi-connect-snapshot.json
npm run connect:snapshot -- roundtrip data/schedi.sqlite
npm run connect:snapshot -- restore /tmp/schedi-connect-snapshot.json /tmp/schedi-restored.sqlite
```

The script copies the SQLite file before it reads, prints counts and a checksum, and does not contact the network. `integrity_check` must be `ok` and `foreign_key_check` must be empty. Restore refuses to overwrite an existing file.

3. On the empty Cloudflare object, `POST /api/admin/sqlite-restore` with the same secret. Without `x-schedi-restore-confirm: restore-empty-database` the call is a dry run and writes nothing. The apply mode refuses a non-empty database. There is no replace mode.

## Cutover

There is no safe dual writer. Railway and the Durable Object are two databases. If both accept webhooks, portal sessions, handoff nonces, local bookings, and subscription rows diverge. Public booking paid notices can both hit `schedi.app`; that endpoint treats a duplicate as success, but the SQLite copies still diverge.

Webhook processing pauses while the two Railway endpoints are disabled. Stripe keeps the events and retries for days. Card checkout also pauses if callers are switched only after the import. That pause is the consistent window. A rolling switch leaves a gap of events that were applied only on Railway.

1. Confirm this Worker is deployed with the secrets above, **no** production route, and an empty object (`SCHEDI_SEED=0`).
2. Disable both Railway webhook endpoints. Do not delete them. Leave `schedi.app/billing/webhook` enabled.
3. Wait for in-flight Railway requests to finish.
4. `GET /api/admin/sqlite-snapshot` from Railway. Run `verify` / checksum the file locally.
5. Dry-run restore against the Worker, then apply with `restore-empty-database`. Compare checksums and row counts. `pragma.integrity` must be `ok`.
6. Set `CONNECT_APP_ORIGIN` on `schedi-email-worker` to the new https origin and deploy that worker. Update the Railway URLs in `site/index.html`, `site/booking.html`, and `site/hq.html`, and add the new origin to `connect-src` in `worker/handler.ts`. Deploy `schedi-web` only from the full asset directory (the restored version plus the updated shell). Do not upload git `site/` by itself.
7. Point **both** enabled Railway webhook endpoints at `https://<connect-host>/api/webhooks/stripe` and re-enable them. Keep each endpoint's existing signing secret. Do not merge the two secrets into one.
8. Watch Stripe deliveries, a sandbox onboarding, a paid and a failed and an asynchronous booking payment, an owner subscription failure, a replayed event, and a portal session. Railway should show no new requests.

## Rollback and observation

During the watch, leave the Railway deployment `82f28802-84b7-49b5-875d-29cf86c2c06f` and the volume in place. Redeploying that release is not a database rollback.

- If the Worker has not accepted a write you need to keep: disable its webhook endpoints, point both URLs back at Railway, restore `CONNECT_APP_ORIGIN` and the shell URLs, re-enable the Railway endpoints. Queued events retry against Railway. Events already marked done on Railway are skipped. Events that exist only on Cloudflare are not in Railway and will be applied again there if Stripe retries them.
- If the Worker has newer rows you must keep, export its snapshot and reconcile before sending traffic back. Do not run two writers to "catch up".
- Do not delete the Railway service. Deletion removes deployments, domains, and variables. The volume can remain and can still bill. Shutdown is a later decision after the watch shows no traffic and the backup restore has been proven.

`connect.schedi.app` was not verified from DNS here. If a hostname already proxies to Railway, move that record in the same window as the webhook URLs. This repository does not attach it.
