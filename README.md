# Schedi

Schedi is booking software for independent businesses. Clients book on a public page. A Pro business can turn on card payments, connect its own Stripe account from the owner portal, and take the client's card payment — including an optional deposit — as a direct charge on that account.

The accepted Connect configuration is in [connect-recommend-plan.md](connect-recommend-plan.md).

- Accounts are created with `/v2/core/accounts`: dashboard `full`, `fees_collector: stripe`, `losses_collector: stripe`, and `configuration.merchant`.
- Charges are direct charges on the connected account. `application_fee_amount` is not set.
- The owner portal embeds `account_onboarding`, `notification_banner`, `account_management`, `payments`, and `payouts`.
- Card checkout and the deposit stay hidden until `configuration.merchant.capabilities.card_payments.status` and `configuration.merchant.capabilities.stripe_balance.payouts.status` are both `active`.
- Owner subscriptions (Free $0, Starter $29/month, Pro $49/month) stay on the Schedi platform account. Schedi reuses one customer per owner and does not pass `customer_account`.
- A failed or canceled owner subscription pauses the public page. A failed client card does not.
- Cash App, Zelle, Venmo, PayPal, and pay-at-appointment never touch the connected account.

## Run

```bash
npm install
npm test
npm run dev
```

Copy `.env.example` to `.env.local` and set a restricted Stripe key (`rk_`) plus the publishable key before a Pro owner can create a connected account. Forward webhooks to `/api/webhooks/stripe`.

An empty database seeds sample businesses. Sign in at `/portal` as `ava@lumen.studio` to turn on card payments, or open `/b/northwind` to see card checkout once capabilities are active.
