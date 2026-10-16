# Square payments plan

This is a plan for a later project. It is not implemented in this preview.

The owner dashboard already lets a business record that a client paid with Square. That is a label on the appointment (`paidMethod: "square"`). It does not charge a card, and Schedi does not hold a Square account for that money.

The later project lets each business connect **its own** Square account, the same idea as the Stripe Connect flow already in this repo (`src/lib/connect.ts`, `src/lib/checkout.ts`, `src/app/api/connect/enable/route.ts`, `src/app/api/webhooks/stripe/route.ts`). A client who picks Square pays that business. Square deposits the money in the business's Square balance, minus Square's processing fee. Schedi, as the agency, collects nothing on that charge. There is no application fee.

The owner's Schedi subscription stays on the existing Stripe billing. That is Schedi charging the business for the software. It is a different payment from the client's visit.

## What Axel does in the Square Developer Dashboard

1. Open [the Square Developer Dashboard](https://developer.squareup.com/apps) and create an application named Schedi. Sandbox and production each have their own application id and secret. Use sandbox until a test payment completes.
2. On the OAuth page, set the production redirect URL to `https://schedi.app/api/square/callback`. Add a preview origin only if a preview host must finish the redirect. Do not put a localhost redirect on the production app.
3. Request only these scopes:
   - `MERCHANT_PROFILE_READ` — the business name and its locations
   - `PAYMENTS_READ` — read a payment after the webhook
   - `PAYMENTS_WRITE` — take the payment, and refund it
   - `ORDERS_READ` and `ORDERS_WRITE` — a Payment Link creates an order
4. Do not request `PAYMENTS_WRITE_ADDITIONAL_RECIPIENTS`. That scope is how an app takes a cut. Schedi does not take one.
5. Put the application id and application secret in Worker secrets (`wrangler secret put`). They never go in the repo, in `index.html`, or on a public tenant doc.
6. Add a webhook subscription. Notification URL: `https://schedi.app/api/webhooks/square`. Events: `payment.updated` and `refund.updated`. Put the webhook signature key in a Worker secret.
7. In sandbox, create a test seller and walk through connect, a payment, and a refund before asking Square to approve production.
8. Production OAuth for payment scopes goes through Square's app review. Confirm the current checklist in the dashboard at submission time. Sandbox works before that review. Customers cannot connect a live Square account until it is approved.

## OAuth

Authorize at `https://connect.squareup.com/oauth2/authorize` (sandbox host: `connect.squareupsandbox.com`) with `client_id`, the scopes above, `session=false`, and a random `state` stored against the owner session.

Square redirects to the callback with `code` and `state`. Reject a missing or mismatched `state`. Exchange the code at `POST /oauth2/token` with `grant_type=authorization_code`. The response includes `access_token`, `refresh_token`, `expires_at`, and `merchant_id`.

Then `GET /v2/locations` with the access token. A payment needs a `location_id`. If the seller has one location, store it. If they have several, the Hours or Payments card asks which location receives online bookings. The location id is not a secret. The merchant id is not a secret. The tokens are.

Refresh with `grant_type=refresh_token` before `expires_at`. If Square returns a new refresh token, replace the stored one. A revoked token (`401` or an invalid-grant style error) marks the account disconnected and stops offering Square on that booking page. Disconnect calls `POST /oauth2/revoke` and deletes the ciphertext in the same step.

## Token storage

Nothing Square uses to charge as the seller may land on the public tenant doc. The browser never receives an access token or a refresh token.

Store one private record on `artifacts/{appId}/private/data/tenants/{slug}` (the same private path the calendar plan uses). Suggested fields: `merchantId`, `locationId`, account name, `expiresAt`, and the ciphertext. Encrypt the access token and the refresh token with AES-256-GCM. A random 12-byte IV per write. The key is a Worker secret (`SQUARE_TOKEN_KEY`), never committed. Decrypt only inside the worker for the Square call.

`AUTH_KV` stays the session store. Do not put Square tokens in it.

## Checkout

Two Square products can take a card. Use Payment Links first.

**Square Payment Links** (`POST /v2/online-checkout/payment-links`). Schedi creates an order for the visit (or the deposit) at the seller's `location_id` and gets back a Square-hosted URL. The booking page sends the client there, the same way Stripe Checkout already redirects. Square hosts the card form. Schedi never sees the card number. Set `checkout_options.redirect_url` back to the booking confirmation. Do not set `app_fee_money`.

Send an `Idempotency-Key` (or the body's `idempotency_key`) derived from the booking id so a retry does not open two checkouts.

**Web Payments SDK** is the other option. Square's card iframe stays on the booking page, `card.tokenize()` returns a `source_id`, and the worker calls `POST /v2/payments`. That is a larger change: the public booking template is hash-pinned, the page's Content-Security-Policy has to allow Square's script and frame, and the worker still creates the payment. Square's iframe keeps the card data off Schedi's server (PCI SAQ A), but the template, CSP, and error states are all extra. Do this only if a hosted Square page is not acceptable. It does not replace the OAuth, token store, or webhook from the Payment Links path.

A visit is one card rail. If the client pays by Square, do not also start a Stripe Checkout for that visit. The existing Stripe cancellation-fee charge applies to a card Stripe already has. A Square payment needs its own refund path, below. Do not run both.

## Webhooks

`payment.updated` is what marks the appointment paid. Verify `x-square-hmacsha256-signature`: HMAC-SHA256 of the notification URL concatenated with the raw body, keyed by the webhook signature key, compared in constant time to the base64 signature. Reject a bad signature before reading the payment as fact.

On `status === COMPLETED`, find the booking from the order id or payment note stored when the link was created. Set `paymentStatus` to a paid value, `paidMethod` to `square`, and `paymentMethod` to `square`. Those three are already on the booking allow list in `workers/schedi-email-worker/src/private-bookings.js`. Ignore a duplicate delivery. A `FAILED` or `CANCELED` payment leaves the appointment unpaid.

`refund.updated` with `status === COMPLETED` records the refund on the appointment. It does not delete the visit unless the owner cancelled it.

## Refunds

The owner starts a refund from the appointment. The worker calls `POST /v2/refunds` with the Square `payment_id`, `amount_money` in the same currency as the payment, and an idempotency key. `PAYMENTS_WRITE` covers this. Refund the amount the client paid through Square, full or partial. The money returns from the seller's Square account to the client's card. Schedi has no balance to refund from, because Schedi never received the charge.

If the seller's Square balance cannot cover the refund, show Square's error and leave the appointment unchanged.

## Fees

Square charges its online processing fee to the connected seller. Confirm the current rate on Square's pricing page before anyone quotes a number to a customer. The rate changes, and it depends on the country and the product (Payment Links versus a keyed payment).

Schedi adds no fee on top. Do not set `app_fee_money`. Do not request the additional-recipient scope. The seller sees a normal Square deposit.

## Rough effort

This is relative size, next to code that already exists. It is not a calendar estimate.

1. Recorded Square label, badges, filter, and this plan. Done in the owner preview. No Square API. Smallest slice.
2. OAuth, encrypted tokens, and the location picker. Medium. New worker routes and the private-doc encryption the calendar plan already describes. Blocked on Axel's Square application and, for live sellers, Square's production review.
3. Payment Links plus the paid webhook. Medium, after phase 2. One deliberate edit of the hash-pinned public booking template so Square is a choice, then a redirect. Closest cousin is `createDirectChargeCheckout` in `src/lib/checkout.ts` and the Stripe webhook route. No application fee.
4. Owner-initiated refunds and `refund.updated`. Small once a Square `payment_id` is stored on the private booking.
5. Web Payments SDK on the booking page. Optional and larger than phase 3. CSP, the booking template again, and tokenize-then-charge. Do not start it until Payment Links have been used for real visits.

Phases 2 through 4 together are about the size of the Stripe Connect direct-charge path already in this repo, plus the private token store. Phase 5 is extra and should not block the first time a client pays a business through Square.

## Implementation note

Phases 2–4 are on the email worker, at the URLs in this plan (`/api/square/callback`, `/api/webhooks/square`). Private bookings and the owner session already live there. The ciphertext is the private-doc field `squareConnection` (AES-256-GCM). It is not copied into `privateView`, so the browser never receives it. The public tenant doc only gets `squareReady` plus the merchant id, location id, and display name after a location is chosen. `SQUARE_ENVIRONMENT=production` selects `connect.squareup.com`; when that var is unset the worker uses the sandbox host. Schedi still does not set `app_fee_money`.
