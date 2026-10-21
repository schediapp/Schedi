/**
 * Cloudflare Email Routing handler for admin@schedi.app and hello@schedi.app.
 * Destinations come from env.ADMIN_FORWARD_TO (comma-separated). Which envelopes
 * to fan out come from env.ADMIN_FORWARD_RECIPIENTS. bookings@ and onboarding@
 * stay off both lists, so this handler does not forward or reject them.
 */

export function parseAddressList(value) {
  const seen = new Set();
  const out = [];
  const parts = String(value || '').split(/[,;\s]+/);
  for (let i = 0; i < parts.length; i += 1) {
    const email = parts[i].trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

export function envelopeRecipient(message) {
  const raw = String((message && message.to) || '').trim().toLowerCase();
  const angled = raw.match(/<([^>]+)>/);
  return (angled ? angled[1] : raw).trim();
}

export async function forwardAdminInbound(message, env) {
  const to = envelopeRecipient(message);
  const allowed = parseAddressList(env && env.ADMIN_FORWARD_RECIPIENTS);
  if (!to || allowed.indexOf(to) < 0) {
    return { ok: true, skipped: true, forwarded: [], failed: [] };
  }
  const destinations = parseAddressList(env && env.ADMIN_FORWARD_TO);
  const forwarded = [];
  const failed = [];
  for (let i = 0; i < destinations.length; i += 1) {
    const dest = destinations[i];
    try {
      if (!message || typeof message.forward !== 'function') throw new Error('forward_unavailable');
      await message.forward(dest);
      forwarded.push(dest);
    } catch (err) {
      failed.push(dest);
      console.error('admin mail forward failed', dest, err && err.message ? err.message : err);
    }
  }
  if (!destinations.length) console.error('admin mail forward failed', 'no destinations');
  return { ok: failed.length === 0 && destinations.length > 0, skipped: false, forwarded, failed };
}
