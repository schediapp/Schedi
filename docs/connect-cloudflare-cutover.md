# Connect app: Railway to Cloudflare

This runbook does not change Stripe, DNS, or the Railway volume.

## Current readiness, November 2026

Railway is stopped. The trial expired. The retained SQLite file has not been recovered. PR 106 (`bbba20c`) is the reviewed online backup helper, and it cannot run while that process is stopped. Do not pay to restart Railway, do not redeploy it, and do not treat that helper as executed. Do not import, seed, or point traffic at production.

The existing Cloudflare worker `schedi-connect` (`f15debb95f7a4dffb860219069fe9435`) stays as it is. This migration uses only `schedi-connect-migration`, with `routes: []`, `workers_dev: false`, `preview_urls: false`, and no secrets in the config file. Do not deploy it from this repository.

The live email worker is v132 plus the minimal `/auth/rename` deny, version `e74eb668-108e-4b9c-bb4b-991699e80829`. The git email-worker tree is not that bundle. Do not publish it over the live worker. PR 104 remains blocked: a Schedi login or a matching email or slug is not ownership of a Connect business. This replacement does not copy that trust. Unstamped owners stay locked out until a later reviewed mapping from an authoritative id that exists on both sides. There is no such mapping in this import.

External effects are not exactly-once. Stripe retries and the ready callback can be delivered more than once. Local event claims and the ready-document precondition stop a second writer from winning a stale or same-second disagreement. They do not prove the receiver applied the effect once.

## Do not overwrite the existing worker

Account `674c2b16e7eac42148f3c06c6e2c954f`. Zone `schedi.app` is `2ade91ff938bbc925314787b560a45a7`.

Cloudflare already has a worker named `schedi-connect`, script `f15debb95f7a4dffb860219069fe9435`. Read-only settings show one binding, `DB`, to D1 database `schedi-connect-db` (`6d51eaa5-cc7d-401e-9f7c-724979436514`). That database's metadata says `num_tables=0`. It is not the Railway database, and it is not disposable. The script has no Durable Object binding, no service binding, and no origin URL in the settings that were returned. `workers.dev` and preview URLs are enabled, so `schedi-connect.axl199.workers.dev` is public. Do not deploy over this script, do not bind its D1 database, and do not turn its workers.dev flag off from this repository. Its settings do not show it proxying Railway. Do not describe it as a proxy.

`workers/schedi-connect/wrangler.jsonc` is the isolated config. The script name is `schedi-connect-migration`. That name was absent from the six-script inventory. It sets `account_id` to the account above, `routes` to `[]`, `workers_dev` false, and `preview_urls` false. Its SQLite is a new Durable Object class `ConnectDatabase` on that script only. The object name var is `schedi-connect-migration`. The migration tag `v1` in this file is not the email worker's AuthRateLimit migration. Do not add a D1, KV, R2, or service binding. Do not run `wrangler deploy`.

`connect.schedi.app` has no exact DNS record, no worker route, and no custom-domain attachment in the zone metadata that was read. Attaching it later would be a new DNS or route change, not a move of an existing one.

## Routes that already exist

Leave these in place. Do not copy them onto `schedi-connect-migration` or onto `schedi-web`.

- `schedi.app/*` is schedi-web, route `1165e79212574f84bfbb447883d8af13`.
- `www.schedi.app/*` is schedi-web, route `83b0607a7b814e299167ef35e111a229`.
- `schedi.app/billing/*` is schedi-email-worker, route `c0567b2b8e784c5a8b548f39c4b5e854`.
- `schedi.app/auth/*` is schedi-email-worker, route `a7027dfc61e74826b03da46f598820a0`.
- The same email worker also owns `/api/webhooks/square*`, `/api/owner-feed/*`, `/api/square/*`, `/api/send-booking-email*`, `/api/calendar-feeds*`, `/api/resend-events*`, `/api/calendar-busy*`, `/api/ops-snapshot*`, `/api/page-visits*`, `/api/booking-ics*`, `/api/push-token*`, `/api/push-test*`, `/api/bookings*`, `/api/clients*`, `/api/profile*`, and `/api/manage*`.
- schedi-email-worker script `e41ad413c9ac450c85aa9415282e4f86` has Durable Object class `AuthRateLimit`, namespace `329f9646423f4e1082ccd44ae35b4348`, migration tag `v1`. Do not publish a new migration for that class.
- schedi-web script `88f9e7c0098e4526bb2cee2f893e78e9` serves assets on the catchall. It has no service binding to Railway or to `schedi-connect`.

Neither worker's plaintext settings contained the Railway hostname or `connect.schedi.app`. That does not list every URL baked into script source. The source callers are in the next section.

## What is actually running on Railway

The saved deployment `82f28802-84b7-49b5-875d-29cf86c2c06f` reports commit `f234d2536cc274149ca678afdb17920c7cc5e08f` (PR 96). The service source config still says `d15d288`. Those are not the same. `f234d253` is the revision to treat as live until a new deployment is read back. It already has the seven Connect tables and the business columns added through `stripe_account_missing_at`. It does not have `stripe_events.state`, `maintenance`, `state_fence`, or `callback_outbox`. Opening this migration's `Store` adds those. That is additive. The auth-only patch does not touch `db.ts`.

`GET /api/admin/sqlite-download` on that revision checks header `x-schedi-connect-secret` against `SCHEDI_CONNECT_PAID_SECRET` and, on a match, returns the bytes of `SCHEDI_DB_PATH` with `readFile`. It does not open the database and it does not run a SQLite backup, so a copy taken while a write is in progress can be torn. It also does not include a `-wal` file if the process is in WAL mode. Use it only as a raw copy after writers are stopped, then run `npm run connect:snapshot -- verify` on the copy. It is not the consistent cutover export. The consistent export is `GET /api/admin/sqlite-snapshot` after `POST /api/admin/maintenance` has frozen the host and `admitted` is 0. Those two routes are on this Next app, so they exist on Railway once this code is the running deployment. They are not on `f234d253`.

Railway can attach a reviewed branch and commit SHA with `connect-service-source` and `staged=true` without merging `main`. That is still a source change and a build. Do not do it from this repository. Autodeploy and Wait for CI are not visible on the connectors used here. A merge to `main` is still possibly a production deploy until someone reads the service source settings.

This runbook does not change Stripe, DNS, or the Railway volume. Do not print secrets. Do not deploy `schedi-web` from git's `site/` folder. Production assets were restored to version `390425bc-78d1-4486-9aca-086675668cb0`; assemble that full asset directory beside the shell.

## What still lives on Railway

The service is the repo-root Next.js app. The running deployment's commit is `f234d2536cc274149ca678afdb17920c7cc5e08f`, not the source-config SHA `d15d288`. One SQLite file at `SCHEDI_DB_PATH` on volume `/data` is the only writer. `SESSION_SECRET` is unused. Sessions are random `schedi_session` cookies with no Domain attribute, so a Railway hostname cookie is not sent to a new hostname.

Both enabled Stripe endpoints still POST `https://schedi-connect-production.up.railway.app/api/webhooks/stripe`. Connected-account events have `event.account`. Platform subscription events update the Connect row that gates `/b/:slug` and the portal. `schedi.app/billing/webhook` updates Firestore and stays there. `invoice.paid` is only handled there.

## Stripe does not queue a disabled endpoint

Stripe's webhook docs say a disabled or deleted destination can stop future retries of an event. Do not disable either Railway endpoint to "hold" events. Leave both enabled. Freeze the process instead: it answers `503` with `Retry-After` and does not write, so Stripe retries while the endpoint is still on.

## Freeze, drain, snapshot

`POST /api/admin/maintenance` with header `x-schedi-migration-secret` and body `{"mode":"frozen"}`. The secret is `SCHEDI_MIGRATION_SECRET`. The paid-callback secret cannot export or freeze.

The freeze is in SQLite. New writers fail the admit update. Requests already inside a handler finish and decrement `admitted`. These routes refuse while frozen: webhooks, checkout, bookings, billing, portal settings, Connect enable/session, handoff POST, and admin backfill/force-park. Portal, booking, and booked pages skip the Stripe refresh and checkout-fulfill writes. A checkout Stripe already opened can still complete at Stripe. Its webhook gets 503 until the host that should own it is unfrozen, then Stripe's retry applies it once.

`GET /api/admin/sqlite-snapshot` with the same migration header works only when `frozen` is true and `admitted` is 0. Otherwise it returns 409 `freeze_required` or `drain_in_progress`. Repeat the GET until it is 200. That body is the consistent export. Keep the old host frozen for the whole observation window. Changing shell links does not stop a browser that still has the Railway URL.

Opening writers again is `{"mode":"open"}` plus header `x-schedi-maintenance-confirm: open-writers`. Do not open the old host while the new host is also accepting writes.

## Import on the isolated object

The object name in the isolated config is `schedi-connect-migration`. It is a new Durable Object namespace on the new script. It does not share storage with D1 `schedi-connect-db` or with AuthRateLimit. Restore is `POST /api/admin/sqlite-restore` with `x-schedi-restore-confirm: restore-empty-database` while that object is frozen and drained. It refuses a non-empty database, checks column parity, rolls back on a foreign-key failure, and re-reads the checksum. Durable Object SQLite rejects `PRAGMA integrity_check` (`SQLITE_AUTH`). The snapshot header then says `unsupported`. Node's file copy still runs `integrity_check` and `foreign_key_check`. Dry-run (`x-schedi-restore-confirm` omitted) writes nothing and reports schema parity.

`workers/schedi-connect/wrangler.jsonc` has `routes: []`, `workers_dev: false`, and `preview_urls: false`. Do not turn those on. Do not attach `schedi.app`, `www.schedi.app`, `/billing/*`, `/auth/*`, or `connect.schedi.app`. An operator ingress, if you add one later, is a new hostname that is not linked from the marketing site, requires the migration secret, and is removed after import. Do not put a live Stripe secret on a worker that is reachable for browser experiments. This config's `compatibility_date` is `2026-10-13` with `nodejs_compat`. The workers already in the account do not have that flag. Local workerd tests override the date to `2026-10-03` because the installed workerd is older. That override is tests only.

## Event recovery

Signed webhook bodies expire. Do not replay old signatures. Keep the endpoints enabled so Stripe retries the 503s at the current URL. After the URL is moved, those retries hit the new host and are idempotent on event id.

Also export events yourself, for both the platform endpoint and the connected-account endpoint, from the freeze boundary through the switch. `delivery_success=false` is not the whole set. Compare that export to the snapshot:

The admin `POST /api/admin/reconcile` body is `{ "events": [ ... ] }`. Without `"apply": true` it only reports platform vs connect counts, missing ids, duplicate ids, and local `pending_payment` bookings (open checkouts). `"apply": true` runs the same handler as the webhook for missing ids. A second run reports those ids as already done. It does not call Stripe.

An older `account.updated` or subscription event does not overwrite a newer observation. The same event may retry. `account.updated` callbacks include `observedAt`. The email worker ignores an older `observedAt` once `stripeConnectObservedAt` is stored. Deploy that email-worker change before cutover or a stale ready flag can still win on the current receiver. Booking-paid retries are duplicates when the payment intent is already recorded.

A crashed handler leaves a `processing` row and does not let a second delivery steal it. After the host is frozen and `admitted` is 0, `POST /api/admin/release-processing` drops those rows. Reconcile then applies the event again. The callback outbox skips a callback that already returned success.

## Rollback after the new host has written

Pointing the URLs back is not a data rollback. Freeze the new host, drain, snapshot it, and diff it against the import snapshot:

```bash
npm run connect:snapshot -- verify-json /tmp/imported.json
npm run connect:snapshot -- diff /tmp/imported.json /tmp/after.json
```

The diff prints added, removed, and changed counts per table, not customer rows. To put the old file back, restore a chosen snapshot onto a new local SQLite file only:

```bash
npm run connect:snapshot -- restore /tmp/chosen.json /tmp/schedi-restored.sqlite
npm run connect:snapshot -- verify /tmp/schedi-restored.sqlite
```

`restore` refuses to overwrite an existing file and writes the JSON snapshot as mode `0600`. Replacing the Railway `/data` file is a parent step with the process stopped. It is not done by this repository. Until that file is in place and the new host is frozen, do not open the old host.

`verify` reads a SQLite file. `verify-json` reads a snapshot JSON file. Neither command contacts the network. Do not use `verify` on a live WAL file. The HTTP snapshot is the consistent copy of the running database.

## Would merging this PR deploy Railway?

Railway's GitHub autodeploy docs say a linked service deploys on pushes to the connected branch unless that trigger is disabled. This service is linked to `schediapp/Schedi` branch `main`. The running deployment is `82f28802-84b7-49b5-875d-29cf86c2c06f` at `f234d2536cc274149ca678afdb17920c7cc5e08f`. The service source config still says `d15d288`. The describe-service result does not show whether autodeploy or "wait for CI" is on. CI in this repo only runs tests, typecheck, and the Next build. It does not deploy. Treat a merge to `main` as a possible Railway deploy of this code, including the new tables and the freeze (the freeze stays off until the maintenance call). Railway can pin a branch and commit SHA without merging `main`. That pin is still a production source change. Do not do it from this repository. The auth-only patch is a separate branch from `f234d253` and does not include this schema.

## Callers in source

These are the fetches and links in this repository. They are not a claim about the existing `schedi-connect` script, which is not this code.

The email worker calls Railway itself:

- `workers/schedi-email-worker/src/connect-origin.js` defaults to `https://schedi-connect-production.up.railway.app`. `CONNECT_APP_ORIGIN` replaces it only when the value is an `https` origin with no path. That variable was not in the email worker's returned plaintext binding names.
- `connectPublicCheckoutUrl` is `{origin}/api/public-checkout`. `index.js` `connectCheckoutUrl` POSTs there. If `checkoutUrl` is missing it falls back to the same Railway URL hardcoded as `CONNECT_PUBLIC_CHECKOUT`. `card-quote-link.js` uses the same origin helper.
- `connect-handoff.js` returns `{origin}/api/connect/handoff#t=` to the browser. The browser then POSTs the token to Railway. The email worker does not fetch that URL.

The Connect app calls back to `schedi.app/billing/*`. Those paths are the email worker, not schedi-web and not the existing `schedi-connect` script:

- `https://schedi.app/billing/connect-booking-paid` from `src/lib/connect-card-payment.ts`
- `https://schedi.app/billing/connect-ready` from `src/lib/connect-ready.ts`
- `https://schedi.app/billing/connect-plan` from `src/lib/plan-entitlement.ts` and the handoff check

The browser, via HTML that schedi-web serves as assets, also calls Railway directly. schedi-web's script does not fetch Railway. `worker/handler.ts` only allows that host in `connect-src`.

- `site/index.html` fetches `https://schedi.app/billing/connect-handoff` (email worker), then expects a Railway handoff URL.
- `site/index.html`, `site/booking.html`, and `site/hq.html` set `CONNECT_PUBLIC_CHECKOUT` to the Railway public-checkout URL. `site/hq.html` links the portal at the Railway host.

Both enabled Stripe webhook endpoints POST `https://schedi-connect-production.up.railway.app/api/webhooks/stripe` directly. They do not pass through these Cloudflare routes.

## Staging and cutover

Do not deploy this config. A later authorized staging deploy is a new script named `schedi-connect-migration` on account `674c2b16e7eac42148f3c06c6e2c954f`, with the routes, workers.dev, and preview flags left as written, and with its own Durable Object SQLite. Recheck that the name is still unused immediately before that deploy. Use test Stripe keys. Do not replay live events into it. Do not bind production D1, KV, R2, or AuthRateLimit.

After a consistent snapshot has been imported there, checksums match, and the missing-event report is empty, the caller change is still a separate step: set `CONNECT_APP_ORIGIN` on the email worker to the new origin, then update the Railway URLs in `site/index.html`, `site/booking.html`, `site/hq.html`, and `connect-src` in `worker/handler.ts`. Deploy `schedi-web` only with the full asset directory, and do not drop the email worker's more specific routes. Then change both webhook endpoint URLs. Leave the old Railway host frozen. Sessions on the new hostname are new. Owners come back through Set up Stripe. Do not put the session token in a query string. `connect.schedi.app` is not already attached, so using that name is a new DNS and route change. Keep the existing workers, the Railway deployment, and the `/data` volume through the rollback window.
