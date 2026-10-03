# Schedi

Schedi is a booking page for independent businesses. Owners pick Free ($0), Starter ($29/month), or Pro ($49/month). A Pro business can turn on card payments, finish Stripe onboarding in the owner portal, and take a card payment or a deposit on the public booking page.

The accepted Connect decisions are in [connect-recommend-plan.md](connect-recommend-plan.md).

## How card payments work

- Schedi creates the business’s account with Accounts v2 (`/v2/core/accounts`): full Dashboard, `fees_collector: stripe`, `losses_collector: stripe`, and `configuration.merchant`. There is no legacy account type and no recipient configuration.
- The client’s card payment is a direct charge on that connected account. The business name is on the charge. `application_fee_amount` is not set. Schedi does not take a cut and does not transfer the funds.
- The owner portal embeds `account_onboarding`, `notification_banner`, `account_management`, `payments`, and `payouts`. Owners use [dashboard.stripe.com](https://dashboard.stripe.com) for the full account.
- Card checkout and the deposit stay hidden until `configuration.merchant.capabilities.card_payments.status` and `configuration.merchant.capabilities.stripe_balance.payouts.status` are both `active`.
- Cash App, Zelle, Venmo, PayPal, and pay-at-appointment never use the connected account.
- Owner subscriptions are normal Billing customers on the Schedi platform account. Schedi does not pass `customer_account` and does not create a second customer for the same owner. A failed or canceled Starter or Pro subscription pauses the public page. A failed client card does not.

Stripe Tax is not turned on. If Schedi charges owners in the US or EU, turn on Stripe Tax only after an active registration exists. See [Collect taxes for recurring payments](https://docs.stripe.com/billing/taxes/collect-taxes.md).

## Setup

Use a [restricted API key](https://docs.stripe.com/keys/restricted-api-keys.md) (`rk_`) stored in the host secrets vault. Do not commit keys.

```bash
cp .env.example .env
npm install
npm start
```

`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, and `STRIPE_WEBHOOK_SECRET` come from the Schedi platform account. Finish the Connect platform profile in the Stripe Dashboard before creating connected accounts.

Point a webhook at `/api/webhooks/stripe`, including events from connected accounts, for:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `payment_intent.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`

Schedi verifies the webhook signature before it reads the event.

Before go-live, run one real Pro business through onboarding, a deposit, a full card payment, a refund, and a failed owner subscription. The public page should pause only for the subscription failure.

## Local simulation

`STRIPE_SIMULATE=1` runs the portal without a secret key. It is refused when `STRIPE_SECRET_KEY` is set, and it must not be used in production. The simulator records the same direct-charge and Accounts v2 calls the live integration makes.

```bash
npm test
```
