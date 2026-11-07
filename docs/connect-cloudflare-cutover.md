# Connect app: Railway to Cloudflare

This runbook does not change Stripe, DNS, or the Railway volume. Do not print secrets. Do not deploy `schedi-web` from git's `site/` folder. Production assets were restored to version `390425bc-78d1-4486-9aca-086675668cb0`; assemble that full asset directory beside the shell.

## What still lives on Railway

The service is the repo-root Next.js app. Deployed commit `d15d2883d0a508bba23475c09c614b8db25e5f8b` is an ancestor of current `main`. One SQLite file at `SCHEDI_DB_PATH` on volume `/data` is the only writer. `SESSION_SECRET` is unused. Sessions are random `schedi_session` cookies with no Domain attribute, so a Railway hostname cookie is not sent to a new hostname.

Both enabled Stripe endpoints still POST `https://schedi-connect-production.up.railway.app/api/webhooks/stripe`. Connected-account events have `event.account`. Platform subscription events update the Connect row that gates `/b/:slug` and the portal. `schedi.app/billing/webhook` updates Firestore and stays there. `invoice.paid` is only handled there.

## Stripe does not queue a disabled endpoint

Stripe's webhook docs say a disabled or deleted destination can stop future retries of an event. Do not disable either Railway endpoint to "hold" events. Leave both enabled. Freeze the process instead: it answers `503` with `Retry-After` and does not write, so Stripe retries while the endpoint is still on.

## Freeze, drain, snapshot

`POST /api/admin/maintenance` with header `x-schedi-migration-secret` and body `{"mode":"frozen"}`. The secret is `SCHEDI_MIGRATION_SECRET`. The paid-callback secret cannot export or freeze.

The freeze is in SQLite. New writers fail the admit update. Requests already inside a handler finish and decrement `admitted`. These routes refuse while frozen: webhooks, checkout, bookings, billing, portal settings, Connect enable/session, handoff POST, and admin backfill/force-park. Portal, booking, and booked pages skip the Stripe refresh and checkout-fulfill writes. A checkout Stripe already opened can still complete at Stripe. Its webhook gets 503 until the host that should own it is unfrozen, then Stripe's retry applies it once.

`GET /api/admin/sqlite-snapshot` with the same migration header works only when `frozen` is true and `admitted` is 0. Otherwise it returns 409 `freeze_required` or `drain_in_progress`. Repeat the GET until it is 200. That body is the consistent export. Keep the old host frozen for the whole observation window. Changing shell links does not stop a browser that still has the Railway URL.

Opening writers again is `{"mode":"open"}` plus header `x-schedi-maintenance-confirm: open-writers`. Do not open the old host while the new host is also accepting writes.

## Import and a second object

The worker's live object name is `schedi-connect`. Tests and a scratch import use `CONNECT_OBJECT_NAME` so they do not touch that object. Restore is `POST /api/admin/sqlite-restore` with `x-schedi-restore-confirm: restore-empty-database` while that object is frozen and drained. It refuses a non-empty database, checks column parity, rolls back on a foreign-key failure, and re-reads the checksum. Durable Object SQLite rejects `PRAGMA integrity_check` (`SQLITE_AUTH`). The snapshot header then says `unsupported`. Node's file copy still runs `integrity_check` and `foreign_key_check`. Dry-run (`x-schedi-restore-confirm` omitted) writes nothing and reports schema parity.

There is no public route in `workers/schedi-connect/wrangler.jsonc` (`routes` empty, `workers_dev` false). Do not turn on `workers_dev` or attach `schedi.app`. An operator ingress, if you add one, is a temporary hostname that is not linked from the marketing site, requires the migration secret, and is removed after import. Do not put a live Stripe secret on a worker that is reachable for browser experiments. Sandbox checks use test keys and `CONNECT_OBJECT_NAME` set to something other than `schedi-connect`.

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

Railway's GitHub autodeploy docs say a linked service deploys on pushes to the connected branch unless that trigger is disabled. This service is linked to `schediapp/Schedi` branch `main`. The live deployment is still `82f28802-84b7-49b5-875d-29cf86c2c06f` at `d15d288`, which is older than `main`, but the describe-service result does not show whether autodeploy or "wait for CI" is on. That is not proof the trigger is off. CI in this repo only runs tests, typecheck, and the Next build. It does not deploy. Treat a merge to `main` as a possible Railway deploy of this code, including the new tables and the freeze (the freeze stays off until the maintenance call). The worker can be deployed from a pinned SHA without merging. Do not merge until someone has looked at the Railway trigger with a sanctioned screen.

## Caller switch

After the checksums match and the missing-event report is empty, set `CONNECT_APP_ORIGIN` on the email worker and update the Railway URLs in `site/index.html`, `site/booking.html`, `site/hq.html`, and `connect-src` in `worker/handler.ts`. Deploy `schedi-web` only with the full asset directory. Then change both webhook endpoint URLs. Leave the old host frozen. Sessions on the new hostname are new. Owners come back through Set up Stripe. Do not put the session token in a query string.
