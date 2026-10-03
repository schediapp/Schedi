const params = new URLSearchParams(location.search);
const sessionId = params.get('session_id');
const status = document.querySelector('#status');

document.querySelector('#pay').addEventListener('click', async () => {
  status.textContent = 'Paying…';
  const response = await fetch('/api/simulate/checkout/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  const body = await response.json();
  if (!response.ok) {
    status.textContent = body.error || 'Payment failed.';
    return;
  }
  location.assign(body.returnUrl);
});
