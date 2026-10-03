const app = document.querySelector('#app');
const parts = location.pathname.split('/').filter(Boolean);
const slug = parts[1];
const isReturn = parts[2] === 'return';

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
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function methodLabel(method) {
  return {
    cashapp: 'Cash App',
    zelle: 'Zelle',
    venmo: 'Venmo',
    paypal: 'PayPal',
    pay_at_appointment: 'Pay at the appointment',
    card: 'Card',
  }[method];
}

async function renderReturn() {
  const params = new URLSearchParams(location.search);
  try {
    const result = await api(`/api/public/${slug}/return?session_id=${encodeURIComponent(params.get('session_id') || '')}`);
    const booking = result.booking;
    app.innerHTML = `
      <section class="panel">
        <h1>${booking.status === 'confirmed' ? 'You are booked' : 'Payment not finished'}</h1>
        <p>${esc(booking.instructions)}</p>
        <p class="muted">${esc(booking.serviceName)} · ${esc(new Date(booking.start).toLocaleString())} · ${money(booking.amountCents)}</p>
      </section>
    `;
  } catch (error) {
    app.innerHTML = `<section class="panel"><h1>Could not confirm the payment</h1><p>${esc(error.message)}</p></section>`;
  }
}

async function renderPage() {
  if (isReturn) return renderReturn();
  let page;
  try {
    page = await api(`/api/public/${slug}`);
  } catch (error) {
    app.innerHTML = `<section class="panel"><h1>Page not found</h1><p>${esc(error.message)}</p></section>`;
    return;
  }
  document.title = page.name;
  if (page.paused) {
    app.innerHTML = `
      <section class="panel">
        <h1>${esc(page.name)}</h1>
        <p class="warn">This booking page is paused until the business updates its Schedi subscription.</p>
      </section>
    `;
    return;
  }
  const canceled = new URLSearchParams(location.search).get('canceled');
  const methods = Object.entries(page.methods).filter(([, value]) => value.enabled);
  if (!page.services.length) {
    app.innerHTML = `
      <h1>${esc(page.name)}</h1>
      <section class="panel"><p>No appointments are open right now.</p></section>
    `;
    return;
  }
  app.innerHTML = `
    <h1>${esc(page.name)}</h1>
    <p class="muted">Book a time. Card payments, when they are on, are charged to ${esc(page.name)}.</p>
    ${canceled ? '<p class="warn">The card payment was canceled. You can try again.</p>' : ''}
    <form class="panel" id="book">
      <label for="service">Service</label>
      <select id="service" required>
        ${page.services.map((service) => `<option value="${esc(service.id)}">${esc(service.name)} · ${money(service.priceCents)} · ${service.durationMin} min</option>`).join('')}
      </select>
      <label for="start">Time</label>
      <input id="start" type="datetime-local" required>
      <div class="row">
        <div>
          <label for="client-name">Your name</label>
          <input id="client-name" required>
        </div>
        <div>
          <label for="client-email">Email</label>
          <input id="client-email" type="email" required>
        </div>
      </div>
      <h2>How to pay</h2>
      ${methods.map(([method, value]) => `
        <label class="choice">
          <input type="radio" name="method" value="${method}">
          <span>${methodLabel(method)}${value.handle ? ` · ${esc(value.handle)}` : ''}</span>
        </label>
      `).join('')}
      ${page.card.available ? `
        <label class="choice" id="card-choice">
          <input type="radio" name="method" value="card">
          <span>Card</span>
        </label>
        ${page.deposit.available ? `
          <label class="choice" id="deposit-choice">
            <input id="deposit" type="checkbox">
            <span>Pay the ${money(page.deposit.amountCents)} deposit by card. The rest is collected in person.</span>
          </label>
        ` : ''}
      ` : ''}
      ${!methods.length && !page.card.available ? '<p class="muted">No payment methods are available yet.</p>' : ''}
      <div class="actions"><button id="book-button" type="submit">Book</button></div>
      <p class="error" id="book-error"></p>
      <p id="book-result"></p>
    </form>
  `;
  const form = document.querySelector('#book');
  if (!form || !page.services.length) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = document.querySelector('#book-error');
    error.textContent = '';
    const selected = form.querySelector('input[name="method"]:checked');
    if (!selected) {
      error.textContent = 'Choose how you will pay.';
      return;
    }
    try {
      const result = await api(`/api/public/${slug}/bookings`, {
        method: 'POST',
        body: JSON.stringify({
          serviceId: document.querySelector('#service').value,
          start: new Date(document.querySelector('#start').value).toISOString(),
          clientName: document.querySelector('#client-name').value,
          clientEmail: document.querySelector('#client-email').value,
          method: selected.value,
          deposit: Boolean(document.querySelector('#deposit')?.checked),
        }),
      });
      if (result.checkoutUrl) {
        location.assign(result.checkoutUrl);
        return;
      }
      document.querySelector('#book-result').textContent = result.booking.instructions;
    } catch (err) {
      error.textContent = err.message;
    }
  });
}

renderPage();
