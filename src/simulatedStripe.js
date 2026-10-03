import crypto from 'node:crypto';
import Stripe from 'stripe';

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

export function createSimulatedStripe({ publicBaseUrl = 'http://127.0.0.1' } = {}) {
  const real = new Stripe('sk_test_simulatedschedikey0000000000');
  const customers = new Map();
  const accounts = new Map();
  const sessions = new Map();
  const subscriptions = new Map();
  const calls = [];

  function record(name, payload) {
    calls.push({ name, payload: structuredClone(payload) });
  }

  function subscriptionFromSession(session) {
    const subscription = {
      id: id('sub'),
      object: 'subscription',
      status: 'active',
      customer: session.customer,
      metadata: { ...(session.subscription_data?.metadata || session.metadata || {}) },
      items: {
        data: [
          {
            id: id('si'),
            price: { id: session.line_items?.[0]?.price || session.line_items?.[0]?.price_data?.product || 'price_sim' },
          },
        ],
      },
    };
    if (session.line_items?.[0]?.price) {
      subscription.items.data[0].price = { id: session.line_items[0].price };
    }
    subscriptions.set(subscription.id, subscription);
    return subscription;
  }

  return {
    calls,
    accounts,
    sessions,
    webhooks: real.webhooks,
    products: {
      async create(params) {
        record('products.create', params);
        return { id: id('prod'), name: params.name };
      },
    },
    prices: {
      async create(params) {
        record('prices.create', params);
        return { id: id('price'), ...params };
      },
    },
    customers: {
      async create(params) {
        record('customers.create', params);
        const customer = { id: id('cus'), ...params };
        customers.set(customer.id, customer);
        return customer;
      },
    },
    checkout: {
      sessions: {
        async create(params, options = {}) {
          record('checkout.sessions.create', { params, options });
          const session = {
            id: id('cs'),
            object: 'checkout.session',
            status: 'open',
            payment_status: 'unpaid',
            url: `${publicBaseUrl}/simulate/checkout?session_id=pending`,
            ...structuredClone(params),
            stripeAccount: options.stripeAccount || null,
          };
          session.url = `${publicBaseUrl}/simulate/checkout?session_id=${session.id}`;
          sessions.set(session.id, session);
          return session;
        },
        async retrieve(sessionId, _params, options = {}) {
          record('checkout.sessions.retrieve', { sessionId, options });
          const session = sessions.get(sessionId);
          if (!session) {
            const error = new Error('No such checkout session');
            error.statusCode = 404;
            throw error;
          }
          return structuredClone(session);
        },
      },
    },
    subscriptions: {
      async retrieve(subscriptionId) {
        record('subscriptions.retrieve', { subscriptionId });
        const subscription = subscriptions.get(subscriptionId);
        if (!subscription) throw new Error('No such subscription');
        return structuredClone(subscription);
      },
      async update(subscriptionId, params) {
        record('subscriptions.update', { subscriptionId, params });
        const subscription = subscriptions.get(subscriptionId);
        if (!subscription) throw new Error('No such subscription');
        if (params.metadata) subscription.metadata = { ...subscription.metadata, ...params.metadata };
        if (params.items?.[0]?.price) subscription.items.data[0].price = { id: params.items[0].price };
        return structuredClone(subscription);
      },
      async cancel(subscriptionId) {
        record('subscriptions.cancel', { subscriptionId });
        const subscription = subscriptions.get(subscriptionId);
        if (!subscription) throw new Error('No such subscription');
        subscription.status = 'canceled';
        return structuredClone(subscription);
      },
    },
    billingPortal: {
      sessions: {
        async create(params) {
          record('billingPortal.sessions.create', params);
          return { url: `${publicBaseUrl}/simulate/billing?customer=${params.customer}` };
        },
      },
    },
    accountSessions: {
      async create(params) {
        record('accountSessions.create', params);
        return { client_secret: `accs_secret_${params.account}` };
      },
    },
    v2: {
      core: {
        accounts: {
          async create(params, options = {}) {
            record('v2.core.accounts.create', { params, options });
            const account = {
              id: id('acct'),
              object: 'v2.core.account',
              display_name: params.display_name,
              dashboard: params.dashboard,
              contact_email: params.contact_email,
              identity: structuredClone(params.identity),
              defaults: structuredClone(params.defaults),
              metadata: structuredClone(params.metadata || {}),
              applied_configurations: ['merchant'],
              configuration: {
                merchant: {
                  capabilities: {
                    card_payments: { status: 'pending', status_details: [] },
                    stripe_balance: { payouts: { status: 'pending', status_details: [] } },
                  },
                  statement_descriptor: structuredClone(params.configuration?.merchant?.statement_descriptor),
                },
              },
            };
            accounts.set(account.id, account);
            return structuredClone(account);
          },
          async retrieve(accountId, params) {
            record('v2.core.accounts.retrieve', { accountId, params });
            const account = accounts.get(accountId);
            if (!account) throw new Error('No such account');
            return structuredClone(account);
          },
          async update(accountId, params) {
            record('v2.core.accounts.update', { accountId, params });
            const account = accounts.get(accountId);
            if (!account) throw new Error('No such account');
            if (params.display_name) account.display_name = params.display_name;
            if (params.configuration?.merchant?.statement_descriptor) {
              account.configuration.merchant.statement_descriptor = structuredClone(
                params.configuration.merchant.statement_descriptor,
              );
            }
            if (params.defaults?.profile) {
              account.defaults.profile = { ...account.defaults.profile, ...params.defaults.profile };
            }
            return structuredClone(account);
          },
        },
      },
    },
    markAccountLive(accountId) {
      const account = accounts.get(accountId);
      if (!account) throw new Error('No such account');
      account.configuration.merchant.capabilities.card_payments.status = 'active';
      account.configuration.merchant.capabilities.stripe_balance.payouts.status = 'active';
      return structuredClone(account);
    },
    markSessionPaid(sessionId) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error('No such checkout session');
      session.status = 'complete';
      session.payment_status = 'paid';
      if (session.mode === 'subscription' && !session.subscription) {
        session.subscription = subscriptionFromSession(session).id;
      }
      return structuredClone(session);
    },
  };
}
