const app = document.querySelector('#app');
const headerLinks = document.querySelector('#header-links');

function money(cents) {
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function authScreen(message = '') {
  headerLinks.innerHTML = '';
  app.innerHTML = `
    <h1>Your booking page, with the business on the charge.</h1>
    <p class="muted">Free, Starter at $29 a month, and Pro at $49 a month. Card payments are Pro, and they land on the business’s own Stripe account.</p>
    <div class="row">
      <form class="panel" id="register">
        <h2>Open a business</h2>
        <label for="reg-name">Business name</label>
        <input id="reg-name" name="name" required>
        <label for="reg-email">Email</label>
        <input id="reg-email" name="email" type="email" required>
        <label for="reg-password">Password</label>
        <input id="reg-password" name="password" type="password" minlength="8" required>
        <div class="row">
          <div>
            <label for="reg-country">Country</label>
            <input id="reg-country" name="country" value="us" maxlength="2" required>
          </div>
          <div>
            <label for="reg-entity">Entity</label>
            <select id="reg-entity" name="entityType">
              <option value="company">Company</option>
              <option value="individual">Individual</option>
            </select>
          </div>
        </div>
        <div class="actions"><button type="submit">Create portal</button></div>
      </form>
      <form class="panel" id="login">
        <h2>Sign in</h2>
        <label for="login-email">Email</label>
        <input id="login-email" name="email" type="email" required>
        <label for="login-password">Password</label>
        <input id="login-password" name="password" type="password" required>
        <div class="actions"><button type="submit">Sign in</button></div>
      </form>
    </div>
    <p class="error" id="auth-error">${esc(message)}</p>
  `;
  document.querySelector('#register').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api('/api/auth/register', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
      await renderPortal();
    } catch (error) {
      document.querySelector('#auth-error').textContent = error.message;
    }
  });
  document.querySelector('#login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    try {
      await api('/api/auth/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(form)) });
      await renderPortal();
    } catch (error) {
      document.querySelector('#auth-error').textContent = error.message;
    }
  });
}

function methodFields(payments) {
  return ['cashapp', 'zelle', 'venmo', 'paypal'].map((method) => {
    const entry = payments[method] || { enabled: false, handle: '' };
    const label = method === 'cashapp' ? 'Cash App' : method[0].toUpperCase() + method.slice(1);
    return `
      <div class="choice">
        <input id="${method}-on" name="${method}-on" type="checkbox" ${entry.enabled ? 'checked' : ''}>
        <div style="flex:1">
          <label for="${method}-handle">${label}</label>
          <input id="${method}-handle" value="${esc(entry.handle)}" placeholder="Handle or address">
        </div>
      </div>
    `;
  }).join('');
}

function mountConnect(publishableKey) {
  const banner = document.querySelector('#notification-banner');
  const onboarding = document.querySelector('#account-onboarding');
  const management = document.querySelector('#account-management');
  const payments = document.querySelector('#payments');
  const payouts = document.querySelector('#payouts');
  if (!publishableKey || !window.StripeConnect) {
    const note = 'Stripe’s embedded components appear here once a publishable key is configured.';
    [banner, onboarding, management, payments, payouts].forEach((node) => {
      if (node) node.innerHTML = `<p class="muted">${note}</p>`;
    });
    return;
  }
  const instance = window.StripeConnect.init({
    publishableKey,
    fetchClientSecret: async () => {
      const body = await api('/api/portal/account-session', { method: 'POST', body: '{}' });
      return body.clientSecret;
    },
    appearance: { overlays: 'dialog', variables: { colorPrimary: '#0e6b52' } },
  });
  const components = [
    ['notification-banner', banner],
    ['account-onboarding', onboarding],
    ['account-management', management],
    ['payments', payments],
    ['payouts', payouts],
  ];
  components.forEach(([name, node]) => {
    node.replaceChildren();
    const element = instance.create(name);
    if (name === 'account-onboarding' && element.setOnExit) {
      element.setOnExit(() => api('/api/portal/cards/refresh', { method: 'POST', body: '{}' }).then(() => renderPortal()));
    }
    node.appendChild(element);
  });
}

async function renderPortal() {
  let me;
  try {
    me = await api('/api/portal/me');
  } catch {
    authScreen();
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.get('plan_return') && params.get('session_id')) {
    await api('/api/portal/plan/confirm', {
      method: 'POST',
      body: JSON.stringify({ sessionId: params.get('session_id') }),
    });
    history.replaceState({}, '', '/portal');
    me = await api('/api/portal/me');
  }
  const business = me.business;

  headerLinks.innerHTML = `<a href="/b/${esc(business.slug)}">Public page</a> · <button class="secondary" id="logout" type="button">Sign out</button>`;
  document.querySelector('#logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    authScreen();
  });

  const cardNote = !business.connected
    ? 'Turn on card payments to create this business’s Stripe account and start onboarding.'
    : business.cardLive
      ? 'Card checkout is live on the public page. Charges are created on this business’s account, with no Schedi fee.'
      : 'Card checkout and the deposit stay hidden until Stripe reports card payments and payouts as active.';

  app.innerHTML = `
    <h1>${esc(business.name)}</h1>
    <p class="muted">${business.paused ? 'The public page is paused because the subscription is not active.' : 'The public page is open.'} Plan: ${esc(business.plan)} · subscription ${esc(business.subscriptionStatus)}</p>
    <section class="panel">
      <h2>Plan</h2>
      <div class="plans">
        ${me.plans.map((plan) => `
          <article class="plan">
            <strong>${esc(plan.name.replace('Schedi ', ''))}</strong>
            <p>${plan.amountCents === 0 ? '$0' : `${money(plan.amountCents)} / month`}</p>
            <button type="button" data-plan="${plan.id}">${business.plan === plan.id ? 'Current plan' : 'Choose'}</button>
          </article>
        `).join('')}
      </div>
      <div class="actions"><button class="secondary" id="billing" type="button">Billing portal</button></div>
      <p class="error" id="plan-error"></p>
    </section>
    <section class="panel">
      <h2>Services</h2>
      <div class="list" id="services">
        ${business.services.map((service) => `
          <article>
            <div><strong>${esc(service.name)}</strong><div class="muted">${money(service.priceCents)} · ${service.durationMin} min</div></div>
            <button class="secondary" type="button" data-remove="${service.id}">Remove</button>
          </article>
        `).join('') || '<p class="muted">No services yet.</p>'}
      </div>
      <form id="service-form">
        <div class="row">
          <div>
            <label for="service-name">Name</label>
            <input id="service-name" required>
          </div>
          <div>
            <label for="service-price">Price (USD)</label>
            <input id="service-price" type="number" min="0.50" step="0.01" required>
          </div>
        </div>
        <label for="service-duration">Minutes</label>
        <input id="service-duration" type="number" min="5" value="60" required>
        <div class="actions"><button type="submit">Add service</button></div>
      </form>
    </section>
    <form class="panel" id="payments-form">
      <h2>Cash App, Zelle, Venmo, PayPal, and pay at the appointment</h2>
      <p class="muted">These stay off Stripe. Clients still book, and the money never touches the connected account.</p>
      ${methodFields(business.payments)}
      <div class="choice">
        <input id="pay-at" type="checkbox" ${business.payments.payAtAppointment.enabled ? 'checked' : ''}>
        <label for="pay-at">Pay at the appointment</label>
      </div>
      <h3>Card deposit</h3>
      <p class="muted">The deposit uses the same direct card charge. The rest is collected in person. It stays hidden until card payments and payouts are active.</p>
      <div class="choice">
        <input id="deposit-on" type="checkbox" ${business.deposit.enabled ? 'checked' : ''}>
        <label for="deposit-on">Offer a deposit</label>
      </div>
      <label for="deposit-amount">Deposit amount (USD)</label>
      <input id="deposit-amount" type="number" min="0.50" step="0.01" value="${(business.deposit.amountCents / 100).toFixed(2)}">
      <div class="actions"><button type="submit">Save payment options</button></div>
      <p class="error" id="pay-error"></p>
    </form>
    <section class="panel" id="cards">
      <h2>Card payments</h2>
      <p>${esc(cardNote)}</p>
      ${business.plan !== 'pro' ? '<p class="warn">Card payments are Pro only.</p>' : ''}
      ${business.plan === 'pro' && !business.connected ? '<button id="enable-cards" type="button">Turn on card payments</button>' : ''}
      ${business.connected ? `
        <p class="muted">Connected account ${esc(business.connectedAccountId)}. Card payments: ${esc(business.cardPaymentsStatus || 'unknown')}. Payouts: ${esc(business.payoutsStatus || 'unknown')}.</p>
        <p><a href="${esc(me.dashboardUrl)}" target="_blank" rel="noreferrer">Open the Stripe Dashboard</a></p>
        <p class="muted">Onboarding, the notification banner, account management, payments, and payouts.</p>
        <div id="notification-banner" class="embed"></div>
        <div id="account-onboarding" class="embed"></div>
        <div id="account-management" class="embed"></div>
        <div id="payments" class="embed"></div>
        <div id="payouts" class="embed"></div>
        ${me.simulate ? '<button class="secondary" id="simulate-live" type="button">Simulate active card payments and payouts</button>' : ''}
      ` : ''}
      <p class="error" id="card-error"></p>
    </section>
    <section class="panel">
      <h2>Bookings</h2>
      <div class="list">
        ${(me.bookings || []).map((booking) => `
          <article class="booking">
            <div><strong>${esc(booking.clientName)}</strong> · ${esc(booking.serviceName)}<div class="muted">${esc(booking.method)} · ${esc(booking.status)} · ${money(booking.amountCents)}</div></div>
            <div>${esc(new Date(booking.start).toLocaleString())}</div>
          </article>
        `).join('') || '<p class="muted">No bookings yet.</p>'}
      </div>
    </section>
  `;

  document.querySelectorAll('[data-plan]').forEach((button) => {
    button.addEventListener('click', async () => {
      const error = document.querySelector('#plan-error');
      error.textContent = '';
      try {
        const result = await api('/api/portal/plan', {
          method: 'POST',
          body: JSON.stringify({ plan: button.dataset.plan }),
        });
        if (result.checkoutUrl) {
          location.assign(result.checkoutUrl);
          return;
        }
        await renderPortal();
      } catch (err) {
        error.textContent = err.message;
      }
    });
  });

  document.querySelector('#billing').addEventListener('click', async () => {
    try {
      const result = await api('/api/portal/billing-portal', { method: 'POST', body: '{}' });
      location.assign(result.url);
    } catch (error) {
      document.querySelector('#plan-error').textContent = error.message;
    }
  });

  document.querySelector('#service-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const price = Math.round(Number(document.querySelector('#service-price').value) * 100);
    await api('/api/portal/services', {
      method: 'POST',
      body: JSON.stringify({
        name: document.querySelector('#service-name').value,
        priceCents: price,
        durationMin: Number(document.querySelector('#service-duration').value),
      }),
    });
    await renderPortal();
  });

  document.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', async () => {
      await api(`/api/portal/services/${button.dataset.remove}`, { method: 'DELETE' });
      await renderPortal();
    });
  });

  document.querySelector('#payments-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      payAtAppointment: { enabled: document.querySelector('#pay-at').checked },
      deposit: {
        enabled: document.querySelector('#deposit-on').checked,
        amountCents: Math.round(Number(document.querySelector('#deposit-amount').value) * 100),
      },
    };
    for (const method of ['cashapp', 'zelle', 'venmo', 'paypal']) {
      payload[method] = {
        enabled: document.querySelector(`#${method}-on`).checked,
        handle: document.querySelector(`#${method}-handle`).value,
      };
    }
    try {
      await api('/api/portal/payments', { method: 'PATCH', body: JSON.stringify(payload) });
      await renderPortal();
    } catch (error) {
      document.querySelector('#pay-error').textContent = error.message;
    }
  });

  const enable = document.querySelector('#enable-cards');
  if (enable) {
    enable.addEventListener('click', async () => {
      try {
        await api('/api/portal/cards/enable', { method: 'POST', body: '{}' });
        await renderPortal();
      } catch (error) {
        document.querySelector('#card-error').textContent = error.message;
      }
    });
  }

  const simulateLive = document.querySelector('#simulate-live');
  if (simulateLive) {
    simulateLive.addEventListener('click', async () => {
      await api('/api/portal/cards/simulate-status', {
        method: 'POST',
        body: JSON.stringify({ cardPayments: 'active', payouts: 'active' }),
      });
      await renderPortal();
    });
  }

  if (business.connected) {
    const start = () => mountConnect(me.publishableKey);
    if (window.StripeConnect || !me.publishableKey) start();
    else document.querySelector('script[src*="connect-js"]').addEventListener('load', start);
    api('/api/portal/account-session', { method: 'POST', body: '{}' }).catch((error) => {
      const node = document.querySelector('#card-error');
      if (node) node.textContent = error.message;
    });
  }
}

renderPortal().catch((error) => authScreen(error.message));
