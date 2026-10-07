# Schedi

Schedi is booking software for independent businesses. Clients book on a public page. A Pro business can turn on card payments, connect its own Stripe account from the owner portal, and take the client's card payment — including an optional deposit — as a direct charge on that account.

The accepted Connect configuration is in [connect-recommend-plan.md](connect-recommend-plan.md).

- Accounts are created with `/v2/core/accounts`: dashboard `full`, `fees_collector: stripe`, `losses_collector: stripe`, and `configuration.merchant`.
- Charges are direct charges on the connected account. `application_fee_amount` is not set.
- The owner portal embeds `account_onboarding`, `notification_banner`, `account_management`, `payments`, and `payouts`.
- Card checkout and the deposit stay hidden until `configuration.merchant.capabilities.card_payments.status` and `configuration.merchant.capabilities.stripe_balance.payouts.status` are both `active`.
- Owner subscriptions (Free $0, Starter $29/month, Pro $49/month) stay on the Schedi platform account. Schedi reuses one customer per owner and does not pass `customer_account`.
- Plans are month-to-month, with no contract. Cancel anytime. Cancellation takes effect at the end of the current paid billing period; the owner keeps access until then and is not charged again. The Connect app sets Stripe `cancel_at_period_end=true` and shows "Your plan stays active until <date>". Resume is available before the period ends. The public page pauses when Stripe sends `customer.subscription.deleted` at period end, not when the owner requests cancellation.
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
