import { chargeStatement, integrationIdentifier } from './statements.js';

const ACCOUNT_INCLUDE = ['configuration.merchant', 'identity', 'defaults', 'requirements'];

export function connectedAccountParams(business, publicBaseUrl) {
  const statement = chargeStatement(business.name);
  const profile = {
    doing_business_as: business.name,
    product_description: 'Appointment bookings',
  };
  if (String(publicBaseUrl || '').startsWith('https://')) {
    profile.business_url = `${publicBaseUrl}/b/${business.slug}`;
  }

  const identity = {
    country: business.country || 'us',
    entity_type: business.entityType === 'individual' ? 'individual' : 'company',
  };
  if (identity.entity_type === 'company') {
    identity.business_details = { registered_name: business.name };
  }

  return {
    contact_email: business.email,
    display_name: business.name,
    dashboard: 'full',
    identity,
    configuration: {
      merchant: {
        capabilities: {
          card_payments: { requested: true },
        },
        statement_descriptor: {
          descriptor: statement.descriptor,
          prefix: statement.prefix,
        },
        support: { email: business.email },
      },
    },
    defaults: {
      currency: 'usd',
      responsibilities: {
        fees_collector: 'stripe',
        losses_collector: 'stripe',
      },
      locales: ['en-US'],
      profile,
    },
    metadata: { schedi_business_id: business.id },
    include: ACCOUNT_INCLUDE,
  };
}

export function accountSessionParams(accountId) {
  return {
    account: accountId,
    components: {
      account_onboarding: {
        enabled: true,
        features: { external_account_collection: true },
      },
      notification_banner: {
        enabled: true,
        features: { external_account_collection: true },
      },
      account_management: {
        enabled: true,
        features: { external_account_collection: true },
      },
      payments: {
        enabled: true,
        features: {
          refund_management: true,
          dispute_management: true,
          capture_payments: true,
        },
      },
      payouts: {
        enabled: true,
        features: {
          standard_payouts: true,
          edit_payout_schedule: true,
          external_account_collection: true,
        },
      },
    },
  };
}

export function directChargeParams({ business, booking, amountCents, title, successUrl, cancelUrl }) {
  const statement = chargeStatement(business.name);
  const description = `${business.name} — ${title}`;
  return {
    params: {
      mode: 'payment',
      client_reference_id: booking.id,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: amountCents,
            product_data: { name: description },
          },
        },
      ],
      payment_intent_data: {
        description,
        statement_descriptor_suffix: statement.suffix,
        metadata: {
          schedi_booking_id: booking.id,
          schedi_business_id: business.id,
          schedi_business_name: business.name,
        },
      },
      metadata: {
        schedi_booking_id: booking.id,
        schedi_business_id: business.id,
        schedi_charge_kind: booking.chargeKind,
        schedi_business_name: business.name,
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      integration_identifier: integrationIdentifier('schedi_book'),
    },
    options: {
      stripeAccount: business.connectedAccountId,
      idempotencyKey: `schedi_booking_${booking.id}`,
    },
  };
}

export function subscriptionCheckoutParams({ business, priceId, planId, successUrl, cancelUrl }) {
  return {
    mode: 'subscription',
    customer: business.stripeCustomerId,
    client_reference_id: business.id,
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: {
      schedi_business_id: business.id,
      schedi_plan: planId,
    },
    subscription_data: {
      metadata: {
        schedi_business_id: business.id,
        schedi_plan: planId,
      },
    },
    integration_identifier: integrationIdentifier('schedi_sub'),
  };
}

export function readCapabilityStatus(account) {
  const capabilities = account?.configuration?.merchant?.capabilities || {};
  return {
    cardPayments: capabilities.card_payments?.status || 'unrequested',
    payouts: capabilities.stripe_balance?.payouts?.status || 'unrequested',
  };
}

export function cardPaymentsLive(account) {
  const status = readCapabilityStatus(account);
  return status.cardPayments === 'active' && status.payouts === 'active';
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry) => walk(entry, visit));
    return;
  }
  Object.keys(value).forEach((key) => visit(key));
  Object.values(value).forEach((entry) => walk(entry, visit));
}

export function assertConnectedAccountParams(params) {
  if (params.type) throw new Error('Legacy account type is not used.');
  if (params.configuration?.customer) {
    throw new Error('Connected accounts are not used to bill the owner.');
  }
  if (params.configuration?.recipient) {
    throw new Error('Direct charges do not use a recipient configuration.');
  }
  if (params.dashboard !== 'full') throw new Error('Connected accounts use the full Dashboard.');
  if (params.defaults?.responsibilities?.fees_collector !== 'stripe') {
    throw new Error('Stripe collects fees from the connected account.');
  }
  if (params.defaults?.responsibilities?.losses_collector !== 'stripe') {
    throw new Error('Stripe is responsible for negative balances.');
  }
  if (!params.configuration?.merchant?.capabilities?.card_payments?.requested) {
    throw new Error('Merchant card payments must be requested.');
  }
}

export function assertDirectCharge(params, options) {
  const keys = [];
  walk(params, (key) => keys.push(key));
  const blocked = ['application_fee_amount', 'transfer_data', 'on_behalf_of', 'destination', 'customer_account', 'payment_method_types'];
  const found = blocked.find((key) => keys.includes(key));
  if (found) throw new Error(`Direct charges must not set ${found}.`);
  if (!options?.stripeAccount) throw new Error('Direct charges are created on the connected account.');
}

export function assertSubscriptionCheckout(params) {
  if (Object.prototype.hasOwnProperty.call(params, 'customer_account')) {
    throw new Error('Owner subscriptions do not use customer_account.');
  }
  if (!params.customer) throw new Error('Owner subscriptions use the platform customer.');
  const keys = [];
  walk(params, (key) => keys.push(key));
  if (keys.includes('payment_method_types')) {
    throw new Error('Subscription checkout must not set payment_method_types.');
  }
}
