/**
 * Flow-gap follow-ups (hourly cron):
 *  1. Unpaid card deposits
 *     - pending or accepted, unpaid, ~1h after booking: ONE "Finish your booking" email with a pay link.
 *     - accepted + unpaid: one more reminder the day before the appointment. Never auto-released;
 *       the pay link stays valid through the appointment day.
 *     - still PENDING (owner hasn't accepted) + unpaid after 24h: release the slot (cancelled, by 'system'),
 *       email the client a short note with "Book another time", and tell the owner.
 *  2. Abandoned paid signups (Starter/Pro checkout never completed): ONE reminder from onboarding@ ~1h later.
 * Every send is stamped on the booking/tenant so it happens at most once.
 */

const APP = 'https://schedi.app';
const NUDGE_AFTER_MS = 60 * 60 * 1000;
const RELEASE_AFTER_MS = 24 * 60 * 60 * 1000;
const OWNER_WARN_AFTER_MS = 19 * 60 * 60 * 1000; // ~5h before release
const SIGNUP_REMIND_AFTER_MS = 60 * 60 * 1000;
const SIGNUP_REMIND_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const GREEN = '#059669';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function firstName(name) {
  const f = String(name || '').trim().split(/\s+/)[0];
  return f || 'there';
}

function ymdInTz(tz, date) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date || new Date());
    const g = (t) => (parts.find((p) => p.type === t) || {}).value;
    return g('year') + '-' + g('month') + '-' + g('day');
  } catch (_) {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDaysYmd(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function friendlyDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function slugOf(tenant) {
  return String((tenant && (tenant.slug || tenant.id)) || '').trim();
}

export function bookingPayUrl(tenant, booking) {
  const u = new URL(APP + '/api/manage/pay');
  u.searchParams.set('t', slugOf(tenant));
  u.searchParams.set('k', String(booking.manageToken || ''));
  return u.toString();
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? '$' + v.toFixed(2) : '';
}

function button(href, label) {
  return '<table role="presentation" cellspacing="0" cellpadding="0" style="margin:20px 0"><tr><td style="border-radius:12px;background:' + GREEN + '">'
    + '<a href="' + esc(href) + '" style="display:inline-block;padding:13px 22px;font-weight:700;color:#ffffff;text-decoration:none;font-size:15px">' + esc(label) + '</a>'
    + '</td></tr></table>';
}

function shell(title, inner, footer) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(title) + '</title></head>'
    + '<body style="margin:0;background:#f0fdf4;padding:24px 12px;font-family:Inter,Arial,sans-serif;color:#0f172a">'
    + '<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #d1fae5;border-radius:16px;padding:28px 24px;line-height:1.55;font-size:15px">'
    + '<h1 style="margin:0 0 14px;font-size:22px;color:#064e3b">' + esc(title) + '</h1>' + inner
    + '</div><p style="text-align:center;color:#64748b;font-size:12px;margin:14px 0 0">' + footer + '</p></body></html>';
}

function detailRows(rows) {
  return '<table role="presentation" style="border-collapse:collapse;margin:14px 0;font-size:14px">'
    + rows.filter((r) => r[1]).map((r) => '<tr><td style="padding:3px 14px 3px 0;color:#64748b">' + esc(r[0]) + '</td><td style="padding:3px 0;font-weight:600">' + esc(r[1]) + '</td></tr>').join('')
    + '</table>';
}

/** Client: "Finish your booking" (first nudge, and the day-before reminder when dayBefore=true). */
export function buildDepositNudgeEmail(tenant, booking, opts) {
  opts = opts || {};
  const biz = String(tenant.name || 'your appointment');
  const accepted = String(booking.status || '').toLowerCase() === 'accepted';
  const when = friendlyDate(booking.date) + (booking.time ? ' at ' + booking.time : '');
  const dep = money(booking.depositAmount);
  const pay = bookingPayUrl(tenant, booking);
  const subject = opts.dayBefore
    ? ('See you tomorrow? Your deposit is still open — ' + biz)
    : ('Finish your booking — ' + biz);
  const lead = opts.dayBefore
    ? (biz + ' is expecting you tomorrow. Your ' + (dep ? dep + ' ' : '') + 'deposit hasn\'t come through yet. You can pay it any time before your appointment.')
    : accepted
      ? ('Good news: ' + biz + ' has your appointment on the calendar. It looks like the ' + (dep ? dep + ' ' : '') + 'deposit didn\'t go through, so here\'s a link to finish it whenever you\'re ready, any time before your appointment.')
      : ('Looks like checkout didn\'t quite finish. Your time is being held, but it needs the ' + (dep ? dep + ' ' : '') + 'deposit to lock it in. It only takes a minute.');
  const hold = (!accepted && !opts.dayBefore)
    ? '<p style="color:#64748b;font-size:13px">If the deposit isn\'t paid within 24 hours of booking, the time is released so someone else can book it. No charge was made.</p>'
    : '';
  const html = shell(opts.dayBefore ? 'Your deposit is still open' : 'Finish your booking',
    '<p>Hi ' + esc(firstName(booking.clientName)) + ',</p><p>' + esc(lead) + '</p>'
    + detailRows([['Service', booking.serviceName], ['When', when], ['Deposit', dep]])
    + button(pay, dep ? ('Pay ' + dep + ' deposit') : 'Pay deposit') + hold
    + '<p style="color:#64748b;font-size:13px">Questions? Just reply to this email and it goes straight to ' + esc(biz) + '.</p>',
    'Sent by Schedi for ' + esc(biz) + '. Ref #' + esc(booking.id));
  const text = 'Hi ' + firstName(booking.clientName) + ',\n\n' + lead + '\n\n'
    + 'Service: ' + (booking.serviceName || '') + '\nWhen: ' + when + (dep ? '\nDeposit: ' + dep : '') + '\n\n'
    + 'Pay here: ' + pay + '\n\n'
    + ((!accepted && !opts.dayBefore) ? 'If the deposit isn\'t paid within 24 hours of booking, the time is released. No charge was made.\n\n' : '')
    + '— ' + biz;
  return { subject, html, text, fromName: biz };
}

/** Client: slot released after 24h unpaid (pending only). */
export function buildDepositReleasedClientEmail(tenant, booking) {
  const biz = String(tenant.name || 'the business');
  const when = friendlyDate(booking.date) + (booking.time ? ' at ' + booking.time : '');
  const book = APP + '/' + slugOf(tenant) + '/';
  const lead = 'We held ' + when + ' for you, but the deposit didn\'t come through, so the time has been released. You weren\'t charged anything.';
  const html = shell('Your held time was released',
    '<p>Hi ' + esc(firstName(booking.clientName)) + ',</p><p>' + esc(lead) + '</p>'
    + '<p>We\'d still love to see you. Pick a new time whenever it suits you.</p>'
    + button(book, 'Book another time'),
    'Sent by Schedi for ' + esc(biz) + '. Ref #' + esc(booking.id));
  const text = 'Hi ' + firstName(booking.clientName) + ',\n\n' + lead + '\n\nWe\'d still love to see you. Book another time: ' + book + '\n\n— ' + biz;
  return { subject: 'Your held time was released — ' + biz, html, text, fromName: biz };
}

/** Owner: we released an unpaid pending request. */
export function buildDepositReleasedOwnerEmail(tenant, booking) {
  const biz = String(tenant.name || 'your business');
  const when = friendlyDate(booking.date) + (booking.time ? ' at ' + booking.time : '');
  const client = String(booking.clientName || 'A client');
  const lead = client + '\'s request for ' + when + ' was never paid, so Schedi released the time after 24 hours. The slot is open again on your booking page, and we let ' + firstName(client) + ' know with a link to book again.';
  const html = shell('Unpaid request released',
    '<p>' + esc(lead) + '</p>'
    + detailRows([['Client', client], ['Service', booking.serviceName], ['When', when], ['Deposit due', money(booking.depositAmount)], ['Email', booking.clientEmail], ['Phone', booking.clientPhone]])
    + '<p style="color:#64748b;font-size:13px">Tip: accept a request in your Roster and Schedi will never auto-release it. The client can then pay any time before the appointment.</p>'
    + button(APP + '/login', 'Open Business Portal'),
    'Schedi · ' + esc(biz) + ' · Ref #' + esc(booking.id));
  const text = lead + '\n\nClient: ' + client + '\nService: ' + (booking.serviceName || '') + '\nWhen: ' + when + '\n\nOpen your portal: ' + APP + '/login';
  return { subject: 'Unpaid request released: ' + client + ', ' + when, html, text };
}

/** Owner: a pending unpaid request will be released in ~5h unless accepted. */
export function buildOwnerReleaseWarningEmail(tenant, booking, releaseAtMs, tz) {
  const biz = String(tenant.name || 'your business');
  const when = friendlyDate(booking.date) + (booking.time ? ' at ' + booking.time : '');
  const client = String(booking.clientName || 'A client');
  let releaseAt = '';
  try {
    releaseAt = new Date(releaseAtMs).toLocaleString('en-US', { timeZone: tz || 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch (_) { releaseAt = new Date(releaseAtMs).toISOString(); }
  const lead = client + ' asked for ' + when + ' but hasn\'t paid the deposit yet. If you don\'t accept or deny it, Schedi will release the time at ' + releaseAt + ' so someone else can book it.';
  const html = shell('Accept or deny this request?',
    '<p>' + esc(lead) + '</p>'
    + detailRows([['Client', client], ['Service', booking.serviceName], ['When', when], ['Deposit due', money(booking.depositAmount)], ['Releases', releaseAt]])
    + '<p><strong>Accept</strong> to keep it: the client can then pay the deposit any time before the appointment, and it will never be auto-released. <strong>Deny</strong> to free the time now.</p>'
    + button(APP + '/login', 'Open Roster to accept or deny')
    + '<p style="color:#64748b;font-size:13px">Do nothing and the time is released automatically. We\'ll let the client know.</p>',
    'Schedi · ' + esc(biz) + ' · Ref #' + esc(booking.id));
  const text = lead + '\n\nAccept to keep it (client can pay any time before the appointment), or deny to free the time now.\n\nOpen your Roster: ' + APP + '/login';
  return { subject: 'Action needed: ' + client + '\'s request releases ' + releaseAt, html, text };
}

/** Owner signup reminder (onboarding@). May name the plan: this is owner-facing. */
export function buildSignupReminderEmail(tenant) {
  const biz = String(tenant.name || 'your business');
  const plan = String(tenant.plan || '').toLowerCase() === 'pro' ? 'Pro' : 'Starter';
  const resume = APP + '/signup?resume=' + encodeURIComponent(slugOf(tenant));
  const lead = 'You were almost done setting up ' + biz + ' on Schedi. Checkout for the ' + plan + ' plan didn\'t finish, so your page is waiting on that last step.';
  const html = shell('Finish setting up your page',
    '<p>Hi ' + esc(firstName(tenant.ownerName)) + ',</p><p>' + esc(lead) + '</p>'
    + '<p>Pick up right where you left off, or start on the Free plan and upgrade later. Either way your booking link stays the same.</p>'
    + button(resume, 'Finish setting up')
    + '<p style="color:#64748b;font-size:13px">If you\'ve already finished, thank you! You can ignore this. Questions? Just reply.</p>'
    + '<p>Axel<br>Schedi</p>',
    'Schedi · schedi.app/' + esc(slugOf(tenant)));
  const text = 'Hi ' + firstName(tenant.ownerName) + ',\n\n' + lead + '\n\nFinish setting up (or switch to Free): ' + resume + '\n\nIf you already finished, you can ignore this.\n\nAxel\nSchedi';
  return { subject: 'Finish setting up your Schedi page', html, text };
}

export function isAwaitingDeposit(booking) {
  if (!booking || booking.walkIn === true) return false;
  if (!(Number(booking.depositAmount) > 0) || booking.depositPaid === true) return false;
  if (booking.cancelled === true) return false;
  const st = String(booking.status || '').toLowerCase();
  if (st !== 'pending' && st !== 'accepted') return false;
  const ps = String(booking.paymentStatus || '').toUpperCase();
  if (ps.indexOf('PAID') !== -1 && ps.indexOf('UNPAID') === -1 && ps.indexOf('AWAITING') === -1) return false;
  return true;
}

function ageMs(booking, now) {
  const t = Date.parse(String(booking.createdAt || ''));
  return Number.isFinite(t) ? now - t : -1;
}

/**
 * deps: { firebaseAnonymousToken, listAllTenants, persistTenantAppointments, sendResend,
 *         tenantPlanName, tenantTimezone, ownerAddress(tenant) }
 */
export async function runDepositFollowups(env, deps, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const idToken = await deps.firebaseAnonymousToken(env);
  const tenants = await deps.listAllTenants(env, idToken);
  const out = { nudged: 0, dayBefore: 0, released: 0, errors: 0, actions: [] };
  for (const tenant of tenants) {
    if (deps.tenantPlanName(tenant) !== 'pro') continue; // card deposits are Pro-only; never act on others
    const appts = Array.isArray(tenant.appointments) ? tenant.appointments.slice() : [];
    const today = ymdInTz(deps.tenantTimezone(tenant), new Date(now));
    const tomorrow = addDaysYmd(today, 1);
    let changed = false;
    const ownerMails = [];
    for (let i = 0; i < appts.length; i++) {
      const b = appts[i];
      if (!isAwaitingDeposit(b)) continue;
      if (String(b.date || '') < today) continue; // appointment day passed: leave it to the owner
      const age = ageMs(b, now);
      if (age < 0) continue;
      const accepted = String(b.status).toLowerCase() === 'accepted';
      const email = String(b.clientEmail || '').trim();
      const act = { tenantId: tenant.id, bookingId: b.id };

      // Release only after the owner has had a real chance to act: the warning must be at least ~4h old
      // (covers cron gaps), unless there is no owner address to warn.
      const warnedAt = Date.parse(String(b.depositOwnerWarnSentAt || ''));
      const ownerHadTime = !deps.ownerAddress(tenant) || (Number.isFinite(warnedAt) && now - warnedAt >= 4 * 60 * 60 * 1000);
      if (!accepted && age >= RELEASE_AFTER_MS && ownerHadTime) {
        const at = new Date(now).toISOString();
        appts[i] = Object.assign({}, b, { status: 'cancelled', cancelled: true, cancelledAt: at, cancelledBy: 'system', depositExpiredAt: at });
        changed = true;
        act.action = 'release';
        if (!opts.dryRun && email) {
          const m = buildDepositReleasedClientEmail(tenant, b);
          const r = await deps.sendResend(env, { to: email, subject: m.subject, html: m.html, text: m.text, fromName: m.fromName });
          if (!r || !r.ok) out.errors++;
        }
        ownerMails.push(b);
        out.released++;
        out.actions.push(act);
        continue;
      }
      if (!accepted && !b.depositOwnerWarnSentAt && age >= OWNER_WARN_AFTER_MS) {
        const to = deps.ownerAddress(tenant);
        if (to) {
          if (!opts.dryRun) {
            const m = buildOwnerReleaseWarningEmail(tenant, b, Math.max(Date.parse(b.createdAt) + RELEASE_AFTER_MS, now + 4 * 60 * 60 * 1000), deps.tenantTimezone(tenant));
            const r = await deps.sendResend(env, { to, subject: m.subject, html: m.html, text: m.text, fromName: 'Schedi' });
            if (!r || !r.ok) out.errors++;
            else { appts[i] = Object.assign({}, appts[i], { depositOwnerWarnSentAt: new Date(now).toISOString() }); changed = true; }
          }
          out.ownerWarned = (out.ownerWarned || 0) + 1;
          out.actions.push({ tenantId: tenant.id, bookingId: b.id, action: 'owner_warn' });
        }
      }
      if (!email) continue;
      if (!appts[i].depositNudgeSentAt && age >= NUDGE_AFTER_MS) {
        act.action = 'nudge';
        if (!opts.dryRun) {
          const m = buildDepositNudgeEmail(tenant, b);
          const r = await deps.sendResend(env, { to: email, subject: m.subject, html: m.html, text: m.text, fromName: m.fromName, replyTo: deps.ownerAddress(tenant) || undefined });
          if (!r || !r.ok) { out.errors++; continue; }
        }
        appts[i] = Object.assign({}, appts[i], { depositNudgeSentAt: new Date(now).toISOString() });
        changed = true;
        out.nudged++;
        out.actions.push(act);
        continue;
      }
      if (accepted && b.depositNudgeSentAt && !b.depositDayBeforeSentAt && String(b.date) === tomorrow) {
        act.action = 'day_before';
        if (!opts.dryRun) {
          const m = buildDepositNudgeEmail(tenant, b, { dayBefore: true });
          const r = await deps.sendResend(env, { to: email, subject: m.subject, html: m.html, text: m.text, fromName: m.fromName, replyTo: deps.ownerAddress(tenant) || undefined });
          if (!r || !r.ok) { out.errors++; continue; }
        }
        appts[i] = Object.assign({}, appts[i], { depositDayBeforeSentAt: new Date(now).toISOString() });
        changed = true;
        out.dayBefore++;
        out.actions.push(act);
      }
    }
    if (changed && !opts.dryRun) {
      // Persisting also re-syncs public slots, so released times open up on the booking page.
      await deps.persistTenantAppointments(env, idToken, tenant.id, appts);
      const to = deps.ownerAddress(tenant);
      for (const b of ownerMails) {
        if (!to) break;
        const m = buildDepositReleasedOwnerEmail(tenant, b);
        const r = await deps.sendResend(env, { to, subject: m.subject, html: m.html, text: m.text, fromName: 'Schedi' });
        if (!r || !r.ok) out.errors++;
      }
    }
  }
  return out;
}

export function signupAwaitingCheckout(tenant, now) {
  if (!tenant) return false;
  const plan = String(tenant.plan || '').toLowerCase();
  if (plan !== 'starter' && plan !== 'pro') return false;
  if (tenant.complimentaryPro === true || tenant.billingExempt === true) return false;
  if (String(tenant.stripeSubscriptionId || '').trim()) return false;
  if (String(tenant.paymentForm || '') !== 'Not subscribed') return false;
  const started = Date.parse(String(tenant.signupStartedAt || ''));
  if (!Number.isFinite(started)) return false;
  const age = (now || Date.now()) - started;
  return age >= 0 && age <= SIGNUP_REMIND_MAX_AGE_MS;
}

/** deps: { firebaseAnonymousToken, listAllTenants, patchTenantFields, sendResend, onboardingFrom } */
export async function runSignupReminders(env, deps, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const idToken = await deps.firebaseAnonymousToken(env);
  const tenants = opts.tenants || await deps.listAllTenants(env, idToken);
  const out = { sent: 0, errors: 0, actions: [] };
  for (const t of tenants) {
    if (!signupAwaitingCheckout(t, now)) continue;
    if (t.signupReminderSentAt) continue;
    if (now - Date.parse(t.signupStartedAt) < SIGNUP_REMIND_AFTER_MS) continue;
    const to = String(t.ownerEmail || '').trim();
    if (!to) continue;
    out.actions.push({ tenantId: t.id, action: 'signup_reminder' });
    if (opts.dryRun) continue;
    const m = buildSignupReminderEmail(t);
    const r = await deps.sendResend(env, { to, subject: m.subject, html: m.html, text: m.text, fromName: 'Schedi', fromAddress: deps.onboardingFrom, replyTo: 'admin@schedi.app' });
    if (!r || !r.ok) { out.errors++; continue; }
    await deps.patchTenantFields(env, idToken, t.id, { signupReminderSentAt: new Date(now).toISOString() });
    out.sent++;
  }
  return out;
}
