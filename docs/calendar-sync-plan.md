# Calendar sync plan

This is a plan for a later project. The owner preview only draws the Hours card and the setup step. It does not add OAuth routes, token storage, worker changes, or edits to the public booking template.

Schedi should skip times the owner is already busy, and, only if they opt in, write Schedi bookings onto one calendar. Three providers: Google Calendar, Outlook / Microsoft 365, and Apple iCloud.

## Where this plugs in today

- Owner conflict check: `getAppointmentBufferMins`, `slotsNeedBuffer`, and `isSlotTaken` in `index.html`. The gap is symmetric: a slot conflicts when `start < otherEnd + buffer && otherStart < end + buffer`. Choices are 0, 5, 10, 15, 20, 30, 45, and 60 minutes. The default is 0. The Hours control is "Break after appointments."
- Public booking page: `slotConflictReason` and `bufferedOverlap` inside the booking template use the same math against `publicSlots`. That template is hash-pinned. A later project has to change it on purpose.
- Server conflict check: `appointmentBufferMins` and `slotTaken` in `workers/schedi-email-worker/src/private-bookings.js`. Create and reschedule both reject with `slot_taken` when the buffer overlaps an existing Schedi booking.
- Private data: `workers/schedi-email-worker/src/tenant-private.js`. Public tenant docs live at `artifacts/{appId}/public/data/tenants/{slug}` and are world-readable. Private docs live at `artifacts/{appId}/private/data/tenants/{slug}`. The browser never reads the private path. The worker uses the Firebase Admin account.
- Worker bindings: `workers/schedi-email-worker/wrangler.toml` has `AUTH_KV` and an hourly cron (`0 * * * *`). Do not put calendar secrets in `AUTH_KV` in the clear, and do not mix them with session keys.

Busy intervals are another input to that same gap. They are not a second buffer.

## Google

Use OAuth on a Web client. Ask for the narrowest scopes that do the job:

| Scope | Why |
| --- | --- |
| `https://www.googleapis.com/auth/calendar.freebusy` | `freebusy.query`. Returns busy intervals, not event titles. |
| `https://www.googleapis.com/auth/calendar.calendarlist.readonly` | Calendar names for "Calendars to check for busy times." Free/busy does not list names. |
| `openid` and `https://www.googleapis.com/auth/userinfo.email` | The connected account address shown in the card. |
| `https://www.googleapis.com/auth/calendar.events` | Create, patch, and delete Schedi events. Request this only after the owner turns on "Add Schedi bookings to my calendar." |

Do not request `https://www.googleapis.com/auth/calendar`. That scope can see, edit, and delete every calendar the account can touch.

The consent screen is External. While the app is in Testing, only listed test users can connect, and Google expires refresh tokens for those users after 7 days. Any other Google user has to wait until verification.

Calendar scopes are sensitive, not restricted, as of this writing. Google changes that classification. Axel confirms the badge on the consent screen before submitting. Sensitive-scope review has no published SLA. A complete submission (privacy policy, domain, demo video, a written reason per scope) often takes several weeks. Restricted-scope review is a heavier process and is not the target here.

### What Axel does in Google Cloud Console

1. Create or select a Google Cloud project used only for Schedi.
2. Enable the Google Calendar API on that project.
3. Open OAuth consent screen. Set user type to External.
4. App name: Schedi. Support email: Axel's. Add the Schedi logo, application home page `https://schedi.app`, a privacy policy URL, and a terms URL. Authorized domain: `schedi.app`.
5. Add the read scopes first: `calendar.freebusy`, `calendar.calendarlist.readonly`, `openid`, and `userinfo.email`. Add `calendar.events` only when write-back ships.
6. Add Axel's Google account under Test users. Leave publishing in Testing until verification is approved.
7. Create an OAuth client ID of type Web application.
8. Authorized redirect URI: `https://schedi.app/api/calendar/google/callback`. Add the worker's preview origin only if a preview host must complete OAuth. Do not use a localhost redirect in the production client.
9. Put the client id and client secret in Worker secrets (`wrangler secret put`). They never go in the repo, in `index.html`, or in a public tenant doc.
10. Copy the project number. Verification asks for it.
11. Before submitting for verification, update the privacy policy so it says Schedi reads free/busy (and, if write-back is on, writes booking events), name Google Calendar, and describe disconnect. Record a short demo of the consent screen and of a client seeing a blocked time with no event title.
12. Submit verification. Until it is approved, only test users can connect. Confirm each scope's sensitive or restricted badge in the console at submission time.

## Microsoft

Register one app in Microsoft Entra ID. Account type: "Accounts in any organizational directory and personal Microsoft accounts" (multi-tenant plus personal). Authorize against the `common` tenant so work and personal accounts both sign in.

Delegated Graph permissions:

- `Calendars.Read` for free/busy (`POST /me/calendar/getSchedule`) and the calendar list. This is the read phase.
- `Calendars.ReadWrite` only when write-back is on, and only via a second consent. It covers create, patch, and delete on the signed-in user's calendars.
- `User.Read` (or `openid` + `email`) for the account address.

Do not request `Calendars.ReadWrite.Shared`. Schedi does not write other people's calendars.

### What Axel does in the Azure portal

1. Microsoft Entra ID, App registrations, New registration. Name: Schedi.
2. Supported account types: any organizational directory and personal Microsoft accounts.
3. Redirect URI, platform Web: `https://schedi.app/api/calendar/microsoft/callback`.
4. API permissions, Microsoft Graph, Delegated: `Calendars.Read` and `User.Read`. Add `Calendars.ReadWrite` only with write-back. Do not add shared-calendar permissions.
5. Grant admin consent in Axel's own tenant so the owner account is not stuck on a consent prompt the tenant admin must approve. Personal Microsoft accounts consent themselves. There is no admin consent for those.
6. Certificates and secrets: create a client secret. Store it as a Worker secret. Record the expiry and rotate it before that date. A secret in the repo is a leak.
7. Copy the Application (client) ID. The authorize and token URLs use tenant `common`, not Axel's directory id, so other organizations and personal accounts can sign in.
8. Complete publisher verification before inviting customers. Until then, consenters see an unverified-publisher warning. That is a store listing and identity step, separate from the code.

## Apple

iCloud has no calendar OAuth for this use. Connect with CalDAV at `https://caldav.icloud.com`.

The owner enters an Apple ID and an app-specific password (the 16-character password from appleid.apple.com, not the Apple ID password). The help page is `https://support.apple.com/en-us/102654`. The preview form already links there and then throws the password away.

The real backend stores the app-specific password encrypted, next to the Apple ID. CalDAV discovery finds the principal and the calendars the owner checked. There is no refresh token. If Apple rejects the password, mark the account disconnected and ask the owner to create a new app-specific password.

## Token storage

Nothing a provider uses to act as the owner may land on the public tenant doc. The browser never receives a refresh token, an access token, or an Apple app-specific password.

Store one private record per provider, either fields on `artifacts/{appId}/private/data/tenants/{slug}` or a private subcollection under that doc. Suggested contents: provider, account email, selected calendar ids, `writeBookings`, ciphertext, and the id of the key version.

Encrypt at rest with AES-256-GCM. A random 12-byte IV per record. The key is a Worker secret (`CALENDAR_TOKEN_KEY`), never committed and never sent to the browser. Store `{ iv, ciphertext, keyVersion }`. Decrypt only inside the worker for the provider call.

What is encrypted:

- Google and Microsoft refresh tokens.
- A short-lived access token only if it is cached at all. Prefer not to persist it: refresh when the busy cache is rebuilt, and keep the access token in that request.
- The Apple app-specific password.

`AUTH_KV` stays the session store. Add a separate `CALENDAR_KV` binding for busy-interval cache. Do not reuse session keys.

Refresh handling:

- Google and Microsoft refresh when the busy cache is stale or a write is about to run. If the provider returns a new refresh token, replace the ciphertext.
- Testing-mode Google tokens die after 7 days. Treat `invalid_grant` as disconnected, not as a retry loop.
- Microsoft client secrets expire. Rotation is an owner task, not a token refresh.

Revocation and disconnect:

- Delete the private ciphertext in the same operation as the UI disconnect.
- Google: revoke the refresh token at `https://oauth2.googleapis.com/revoke`.
- Microsoft: delete the stored token. Also tell the owner they can remove Schedi at account.microsoft.com. Graph does not offer one revoke call that covers every account type.
- Apple: delete the stored password. Tell the owner to revoke that app-specific password at appleid.apple.com. Schedi cannot revoke it remotely.
- Drop that provider's busy-cache keys. A disconnected account must not keep blocking the book.

## Busy-time cache

Cache opaque intervals only: `{ start, end }` in UTC, plus the tenant id, provider, and calendar id. No title, location, attendees, or description.

TTL is 10 minutes, covering the bookable horizon (the same window the public page already offers, not the owner's whole history). The hourly cron can refresh connected tenants so the first visitor of the hour is not waiting on Google.

Push versus poll:

- Google Calendar push (`events.watch`) notifies the worker that a calendar changed. Channels expire (on the order of a month). The cron renews them before expiry. The webhook checks the channel token and then refreshes that calendar's cache. It does not trust the body as the new busy set.
- Microsoft Graph change subscriptions on the user's events expire in under three days. The same cron renews them. A notification triggers a cache refresh. It is not the busy data itself.
- Apple CalDAV on iCloud has no usable push for this. Poll on the TTL.
- If a webhook is missed, the TTL poll still corrects the book. Webhooks are an optimization, not the source of truth.

If the owner unchecks every calendar, cache nothing for that account and do not block external time. The preview already tells them to pick at least one.

## How the book consumes busy times

Public slot generation today runs in the browser. The later project publishes opaque busy blocks (date plus start and end minutes in the business timezone, or UTC instants the page converts) and teaches `slotConflictReason` to run `bufferedOverlap` against them with `appointmentBufferMins`. Clients still see the existing reasons ("Already booked", the buffer message, closed, and so on). They never see an external event title or which calendar blocked the time.

That is a deliberate edit of the hash-pinned booking template. Shipping the cache without that edit does not change the public page.

`slotTaken` in `private-bookings.js` must apply the same blocks on create and on reschedule. Otherwise a client can post a time the page hid. Owner `isSlotTaken` uses the same helper so a manual booking cannot land on a busy interval the public page rejected.

All-day events block that local day in `tenant.timezone` (default `America/New_York`). A timed event blocks its range plus the buffer on both sides. The buffer is the gap the owner already saved. It is not a new setting.

A stale-but-inside-TTL cache is fine to serve. A cache older than the TTL is refreshed before the page answers, with a short timeout. See failure modes for the timeout.

## Writing Schedi bookings to the owner's calendar

This runs only when `writeBookings` is on for that account. The preview toggle is the same switch.

- On accept (or on create, if the business auto-accepts), create one event on the calendar the owner picked as the write target. If they checked several busy calendars, write to the first checked calendar and say so in the UI when this is built. Do not write the same booking to every checked calendar.
- Store the provider event id, and a stable iCal UID derived from the Schedi booking id, on the private booking record. Not on the public slot doc.
- Reschedule and edit patch that event. Cancel and deny delete it.
- Before creating, look up the UID. A retry updates the existing event instead of adding a second one.
- Event text is the service name and the client name, plus a link back to the booking in the owner dashboard. No card data, no payment ids, no manage token.
- If the provider write fails, the Schedi booking still stands. Queue a retry on the hourly cron and show the owner a warning on that appointment. Do not roll the client's booking back because Google was down.
- Disconnect or turning the toggle off stops future writes. It does not delete events already created unless the owner disconnects and we still have the event ids. Disconnect should delete those events best-effort, then drop the tokens either way.

## Failure modes

- Revoked or expired refresh token, or an Apple password Apple rejects: mark that provider disconnected, clear its cache, and keep enforcing Schedi bookings. The Hours card asks them to connect again.
- Provider timeout or 5xx: if the cache is inside the TTL, use it. If not, fail open for external busy only. Schedi bookings and the buffer still block. Show the owner a warning. Do not fail the public page.
- Rate limit: serve the cache, back off, and let the cron retry. Do not loop inside the booking request.
- Owner unchecked every calendar: external busy does not block. The card already says to pick one.
- All-day events and timezone skew: compare in the tenant timezone. An all-day event is the whole local day, not midnight-to-midnight UTC.
- Write succeeded and the response was lost: the UID lookup keeps the retry idempotent.
- Write failed after the booking was saved: the booking stays, the retry cron keeps the event id once it lands.
- Google app still in Testing: non-test users cannot connect, and test-user refresh tokens die after 7 days. That is expected until verification.
- Webhook forgery: ignore payloads that do not match a channel or subscription Schedi created. Refresh from the provider API, not from the webhook body.

## Privacy

- Clients never receive external titles, descriptions, or attendees. A blocked time looks like any other unavailable time.
- Logs must not contain tokens, Apple passwords, or event titles. Log provider, tenant id, and a status code.
- The public tenant document never holds ciphertext.
- Disconnect deletes ciphertext and cache in the same step as revocation.
- Read-only scopes stay in place until the owner opts into write-back. That second consent is separate.
- The privacy policy and terms have to name Google, Microsoft, and Apple, say that busy times are read, and say that booking details are written only if the toggle is on. Google verification will reject a policy that does not match the scopes.
- Demo mode is local. It does not call a provider, and the Apple form discards the password after a format check.

## Phased rollout

Effort below is relative size and what has to change. It is not a calendar estimate.

1. Preview UI and this plan. Done in the owner-dashboard preview. No network. Smallest slice.
2. Google read. Largest slice. New worker routes for the OAuth callback, encrypted refresh tokens on the private tenant doc, `CALENDAR_KV`, a 10-minute free/busy cache, opaque blocks into public slot generation (explicit booking-template edit), and the same blocks inside `slotTaken` and owner `isSlotTaken`. Depends on Axel finishing the Cloud Console checklist. Test users work before verification. Everyone else waits on Google.
3. Microsoft read. Medium, after the token store and cache exist. New Azure app, Graph `getSchedule`, same busy shape. Depends on Axel's app registration and, for a clean consent screen, publisher verification.
4. Apple read. Medium. CalDAV plus the encrypted app-specific password. Poll only. No OAuth review. Depends on the same cache and the same conflict checks.
5. Write-back. Medium. Extra scopes (`calendar.events`, `Calendars.ReadWrite`) and a second consent. Event id stored on the private booking. Create, patch, delete, idempotent UID. A failed write must not fail the Schedi booking. Ships behind the toggle, one provider at a time, Google first.
6. Push notifications and production Google access. Medium, and only after phase 2 has been stable. Google watch channels and Graph subscriptions, renewed by the existing hourly cron, with polling left as the fallback. Moving the Google app from Testing to production is the verification submission in the checklist above, not a code change.
