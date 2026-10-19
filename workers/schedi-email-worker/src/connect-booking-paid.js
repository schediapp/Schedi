function secretMatches(expected, got) {
  const a = String(expected || '');
  const b = String(got || '');
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Schedi Connect calls this after a public booking's card checkout or payment link is paid.
 * The owner dashboard reads the private roster, which this updates.
 */
export async function handleConnectBookingPaid(request, env, deps) {
  const json = deps.json;
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const expected = String((env && env.SCHEDI_CONNECT_PAID_SECRET) || '');
  const header = request.headers.get('x-schedi-connect-secret') || '';
  if (!secretMatches(expected, header)) return json({ ok: false, error: 'unauthorized' }, 401);
  let body = {};
  try {
    body = await request.json();
  } catch (_) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (!body || typeof body !== 'object') return json({ ok: false, error: 'invalid_json' }, 400);
  const result = await deps.markPaid(body);
  const ok = !!(result && (result.ok || result.duplicate));
  return json({ ok: true, result: result || {} }, ok ? 200 : 500);
}
