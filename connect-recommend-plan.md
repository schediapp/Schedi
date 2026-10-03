## Recommended Connect integration

Accepted by Axel on Oct 3, 2026.

### A. Account configuration
Accounts API: `/v2/core/accounts`
Legacy account type: not used
Dashboard: full
Fee collection: Stripe bills the connected account (`fees_collector: stripe`)
Negative balance liability: Stripe (`losses_collector: stripe`)

Each business is its own merchant. They already run the booking page, set the prices, and own the client relationship, so they should own the Stripe account too. Each connected account needs merchant configuration (`configuration.merchant`) so it can take direct card charges.

### B. Charge pattern: direct
The client pays on that business's booking page, and the charge is created on the business's account. Their name is what the client sees. Stripe pays the business out on the business's own payout schedule. Schedi never holds the money and never forwards it.

### C. Business onboarding
Onboarding method: embedded, inside the owner portal.

An owner turns on card payments (Pro only). Schedi creates their connected account, then the portal shows Stripe's onboarding so they can verify the business. Keep showing the notification banner when Stripe asks for something new. Do not turn on live card checkout, including the deposit, until card payments are active on that account. Cash App, Zelle, Venmo, PayPal, and pay-at-appointment stay as they are. Those never touch this account.

### D. Payments dashboard access
Owners sign in at dashboard.stripe.com and see their own charges, payouts, and disputes there. The Schedi portal can still show a lighter view, but Stripe's Dashboard is the real one.

### E. Embedded components
- `account_onboarding`
- `notification_banner` (required)
- `account_management`
- `payments`
- `payouts`

Direct charges show full payment and dispute detail in these components.

### F. Webhook integration
Use webhooks for reliable payment confirmation, especially for async payment methods. Always verify incoming webhook signatures before processing event data. Specific events and implementation details belong in the build, not this plan.

### G. Onboarding status gating
Before a business can take a live card payment, retrieve the account and require `configuration.merchant.capabilities.card_payments.status === 'active'`, and check that payouts are active in that same merchant configuration. If either is not active, hide card checkout and the deposit.

### H. Fee structure
- Platform fee model: none on client card payments
- `application_fee_amount` strategy: platform fee only, and the fee is $0, so do not set `application_fee_amount`
- The client pays the business. Stripe takes its processing fee from that business, not from Schedi. Rates depend on the card and country: https://stripe.com/pricing
- Nothing is transferred from Schedi to the business, because the charge never landed on Schedi.

Client pays the service price, the charge is created on the business's connected account, Stripe deducts its processing fee there, and the business keeps the rest. Schedi keeps $0 of this charge.

### I. SaaS monetization
Schedi makes money from the subscription, not from the booking. Starter is $29 a month, Pro is $49, Free is $0. Keep billing those on the Schedi Stripe account as normal customers. Do not use `customer_account`, and do not create a second customer record for the same owner. A failed or canceled subscription still pauses the public page.

### J. Implementation plan
1. In the Stripe Dashboard, finish the Connect platform profile for Schedi.
2. When a Pro owner turns on cards, create a v2 account with dashboard `full`, fee collection `stripe`, negative balance liability `stripe`, and merchant configuration.
3. Embed onboarding, the notification banner, account management, payments, and payouts in the owner portal.
4. On the public booking page, create the card charge (and the deposit, if it is on) as a direct charge on that business's account. Leave `application_fee_amount` off.
5. Gate the card button on the capability check above. Confirm the booking only after the payment succeeds.
6. Before go-live, run one real Pro business through onboarding, a deposit, a full card payment, a refund, and a failed owner subscription, and confirm the page pauses only for the subscription failure.

### K. Risk and liability
Negative balance liability: Stripe. If a client disputes a charge, the disputed amount can create a negative balance on that business's account, and Stripe absorbs unresolved negative balances. Not Schedi.

Risk management: Stripe. Radar runs on the connected account. Schedi does not need its own fraud rules for these charges.

### L. Why this fits
- The business is who the client is paying, so the business is the merchant of record.
- Schedi already charges owners a subscription, so it does not need a cut of each booking.
- A failed owner subscription and a failed client card are different events. Only the subscription pauses the page.
- Owners can already see their own bookings. Giving them the full Dashboard matches that.

### M. Open questions
- No cut of a client card payment, unless Axel says otherwise.
- The deposit uses this same direct charge. The rest is still collected in person.
- Card payments stay Pro only, matching the portal.
