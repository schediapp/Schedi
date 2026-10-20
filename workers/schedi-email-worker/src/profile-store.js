/**
 * Owner and agency profile writes. Browser clients do not write Firestore.
 * The worker writes with the Firebase Admin service account, which bypasses rules.
 */
import { readSession, deleteOwnerSecret } from './owner-auth.js';
import { requireAgency } from './agency-session.js';
import { adminAuthHeaders } from './firebase-admin.js';
import {
  splitTenant,
  shapePublicBookingFields,
  patchPrivateTenant,
  deletePrivateTenant,
  getPrivateTenant,
  listPrivateTenants,
  privateView,
  migrateTenantsToPrivate,
  AGENCY_ONLY_PRIVATE_KEYS,
  PRIVATE_TENANT_KEYS,
  PUBLIC_ADDRESS_KEYS,
  SQUARE_PUBLIC_ID_KEYS,
  WORKER_ONLY_PRIVATE_KEYS,
  decodeDoc,
} from './tenant-private.js';
import { applyOwnerEntitlementLock } from './entitlements.js';
import { normalizeMinNoticeHours } from './booking-notice.js';

const FORBIDDEN = new Set([
  'ownerPassword',
  'appointments',
  'publicSlots',
  'externalBusy',
  'clientName',
  'clientEmail',
  'clientPhone',
  'manageToken',
  '_privateBookingsLoaded',
  'squareConnection',
  'squareTokenCipher',
  'squareAccessToken',
  'squareRefreshToken',
]);

function projectBits(env) {
  return {
    projectId: String(env.FIREBASE_PROJECT_ID || 'siteforge-97699').trim(),
    appId: String(env.FIREBASE_APP_ID || 'siteforge-97699').trim(),
  };
}

function tenantsCollectionUrl(env) {
  const { projectId, appId } = projectBits(env);
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/artifacts/${appId}/public/data/tenants`;
}

function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return '';
  return id;
}

function encodeFirestoreValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeFirestoreValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) {
      if (v[k] !== undefined) fields[k] = encodeFirestoreValue(v[k]);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function cleanServiceText(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

/** Catalog fields an owner may save on a service. Drops data-URL leftovers and unknown keys. */
export function sanitizeService(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const idRaw = raw.id;
  if (typeof idRaw === 'number' && Number.isFinite(idRaw)) out.id = idRaw;
  else if (typeof idRaw === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(idRaw.trim())) out.id = idRaw.trim();
  const name = cleanServiceText(raw.name, 160);
  if (name) out.name = name;
  if (raw.duration != null && raw.duration !== '') {
    const duration = cleanServiceText(raw.duration, 40);
    if (duration) out.duration = duration;
  }
  const mins = Number(raw.durationMins);
  if (Number.isFinite(mins) && mins > 0 && mins <= 24 * 60) out.durationMins = Math.round(mins);
  if (raw.price === null) out.price = null;
  else if (typeof raw.price === 'number' && Number.isFinite(raw.price) && raw.price >= 0 && raw.price <= 1000000) out.price = raw.price;
  if (typeof raw.desc === 'string') out.desc = cleanServiceText(raw.desc, 500);
  const icon = cleanServiceText(raw.icon, 80).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  if (icon) out.icon = icon;
  const imageUrl = cleanServiceText(raw.imageUrl, 500);
  if (/^https:\/\/\S+$/i.test(imageUrl)) out.imageUrl = imageUrl;
  const sortOrder = Number(raw.sortOrder);
  if (Number.isInteger(sortOrder) && sortOrder >= 0 && sortOrder <= 10000) out.sortOrder = sortOrder;
  if (raw.hidden === true) out.hidden = true;
  if (raw.inactive === true) out.inactive = true;
  if (raw.active === false) out.active = false;
  if (raw.enabled === false) out.enabled = false;
  const status = cleanServiceText(raw.status, 20).toLowerCase();
  if (status === 'hidden' || status === 'inactive') out.status = status;
  if (out.id == null && !out.name) return null;
  return out;
}

export function sanitizeProfile(raw, tenantId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!k || FORBIDDEN.has(k) || k.charAt(0) === '_') continue;
    if (raw[k] === undefined) continue;
    out[k] = raw[k];
  }
  if (Array.isArray(out.services)) {
    out.services = out.services.map(sanitizeService).filter(Boolean).slice(0, 200);
  }
  // Public tenant doc. The booking page reads this to hide start times that are too soon.
  if (Object.prototype.hasOwnProperty.call(out, 'minNoticeHours')) {
    out.minNoticeHours = normalizeMinNoticeHours(out.minNoticeHours);
  }
  out.id = tenantId;
  return out;
}

function canWrite(session, tenantId) {
  if (!session) return false;
  if (session.role === 'agency') return true;
  if (session.role === 'owner' && session.tenantId === tenantId) return true;
  return false;
}

async function getPublicTenantDoc(env, tenantId, headers) {
  const res = await fetch(tenantsCollectionUrl(env) + '/' + encodeURIComponent(tenantId), { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn('profile read before write failed', res.status);
    throw new Error('profile_read_failed');
  }
  return decodeDoc(await res.json());
}

function publicWriteMask(pub) {
  const drop = SQUARE_PUBLIC_ID_KEYS.concat(WORKER_ONLY_PRIVATE_KEYS, PRIVATE_TENANT_KEYS);
  if (pub && pub.showPublicAddress === false) drop.push.apply(drop, PUBLIC_ADDRESS_KEYS);
  return Array.from(new Set(Object.keys(pub || {}).concat(drop)));
}

/** Returns the list of owner-sent fields that were ignored by the plan/entitlement lock. */
async function putTenant(env, tenantId, profile, role) {
  // Owner contact + billing fields go to the private doc (merge, only keys present);
  // the world-readable public doc keeps booking-page fields only.
  const split = splitTenant(profile);
  let pub = split.pub;
  let priv = split.priv;
  const headers = await adminAuthHeaders(env);
  let ignored = [];
  if (role !== 'agency') {
    // Plan lock: plan keeps its stored value. Billing keys (monthlyPrice, complimentaryPro,
    // billingExempt, paymentForm, Stripe ids) are dropped. subscriptionStatus stays on
    // the public doc; an owner cannot change it. Pro-only features can't be switched
    // on unless the stored plan is Pro (or complimentary Pro).
    const storedPub = await getPublicTenantDoc(env, tenantId, headers);
    if (!storedPub) throw new Error('tenant_not_found');
    const storedPriv = await getPrivateTenant(env, tenantId);
    for (const k of Object.keys(priv)) {
      if (AGENCY_ONLY_PRIVATE_KEYS.has(k)) {
        const before = storedPriv ? storedPriv[k] : undefined;
        if (JSON.stringify(priv[k]) !== JSON.stringify(before)) ignored.push(k);
        delete priv[k];
      }
    }
    const locked = applyOwnerEntitlementLock(pub, storedPub, storedPriv);
    pub = locked.pub;
    ignored = ignored.concat(locked.ignored);
    const effective = Object.assign({}, storedPub, pub);
    const storedStatus = Object.prototype.hasOwnProperty.call(storedPub, 'subscriptionStatus')
      ? storedPub.subscriptionStatus
      : (storedPriv && Object.prototype.hasOwnProperty.call(storedPriv, 'subscriptionStatus') ? storedPriv.subscriptionStatus : undefined);
    if (Object.prototype.hasOwnProperty.call(profile, 'subscriptionStatus') && JSON.stringify(profile.subscriptionStatus) !== JSON.stringify(storedStatus)) {
      ignored.push('subscriptionStatus');
    }
    if (storedStatus !== undefined) effective.subscriptionStatus = storedStatus;
    else delete effective.subscriptionStatus;
    if (storedPriv && storedPriv.complimentaryPro !== undefined) effective.complimentaryPro = storedPriv.complimentaryPro;
    if (storedPriv && storedPriv.billingExempt !== undefined) effective.billingExempt = storedPriv.billingExempt;
    if (storedPriv && storedPriv.monthlyPrice !== undefined) effective.monthlyPrice = storedPriv.monthlyPrice;
    pub = shapePublicBookingFields(effective).pub;
  } else {
    const shaped = shapePublicBookingFields(Object.assign({}, pub, priv));
    pub = shaped.pub;
    priv = shaped.priv;
  }
  if (Object.keys(priv).length) await patchPrivateTenant(env, tenantId, priv);
  const mask = publicWriteMask(pub);
  const qs = mask.map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const fields = {};
  for (const k of Object.keys(pub)) fields[k] = encodeFirestoreValue(pub[k]);
  const res = await fetch(tenantsCollectionUrl(env) + '/' + encodeURIComponent(tenantId) + '?' + qs, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    console.warn('profile write failed', res.status);
    throw new Error('profile_write_failed');
  }
  return ignored;
}

async function deleteSlots(env, tenantId, auth) {
  let pageToken = '';
  do {
    const url = tenantsCollectionUrl(env) + '/' + encodeURIComponent(tenantId) + '/slots?pageSize=200'
      + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: auth } });
    if (res.status === 404) return;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.warn('slot list for delete failed', res.status);
      throw new Error('profile_delete_failed');
    }
    for (const doc of data.documents || []) {
      if (!doc.name) continue;
      const del = await fetch('https://firestore.googleapis.com/v1/' + doc.name, {
        method: 'DELETE',
        headers: { Authorization: auth },
      });
      if (!del.ok && del.status !== 404) {
        console.warn('slot delete failed', del.status);
        throw new Error('profile_delete_failed');
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
}

async function deleteTenant(env, tenantId) {
  const headers = await adminAuthHeaders(env);
  const auth = headers.Authorization;
  await deleteSlots(env, tenantId, auth);
  const res = await fetch(tenantsCollectionUrl(env) + '/' + encodeURIComponent(tenantId), {
    method: 'DELETE',
    headers: { Authorization: auth },
  });
  if (!res.ok && res.status !== 404) {
    console.warn('profile delete failed', res.status);
    throw new Error('profile_delete_failed');
  }
  await deletePrivateTenant(env, tenantId);
  // Also remove the owner login so a deleted business can't shadow the owner's other businesses.
  try { await deleteOwnerSecret(env, tenantId); } catch (e) { console.warn('owner login cleanup failed'); }
}

function timingSafeEqualStr(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  let diff = left.length ^ right.length;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i += 1) diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  return diff === 0;
}

/** Maintenance: one-time move of private fields off public docs. Agency session plus MIGRATION_TOKEN. */
async function handleMigratePrivate(request, env, origin, json, body) {
  const gate = await requireAgency(env, request, body);
  if (!gate.ok) return json({ ok: false, error: gate.error }, gate.status, origin);
  const expected = String(env.MIGRATION_TOKEN || '').trim();
  const auth = String(request.headers.get('Authorization') || '');
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!expected || expected.length < 32 || !given || !timingSafeEqualStr(given, expected)) {
    return json({ ok: false, error: 'unauthorized' }, 401, origin);
  }
  try {
    const result = await migrateTenantsToPrivate(env, { dryRun: body.dryRun !== false });
    return json(result, result.ok ? 200 : 500, origin);
  } catch (e) {
    return json({ ok: false, error: 'migration_failed', detail: String(e && e.message || e).slice(0, 200) }, 500, origin);
  }
}

export async function handleProfileRequest(request, env, origin, json) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, origin);
  }
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  if (body && body.action === 'migrate_private') return handleMigratePrivate(request, env, origin, json, body);
  const session = await readSession(env, body.session);
  if (!session || (session.role !== 'agency' && session.role !== 'owner')) {
    return json({ ok: false, error: 'session_required' }, 401, origin);
  }
  const action = String(body.action || 'save').slice(0, 20);

  if (action === 'private') {
    // Owner contact + billing fields for the signed-in owner (own business) or agency (all).
    try {
      if (session.role === 'owner') {
        const id = safeId(session.tenantId);
        if (!id) return json({ ok: false, error: 'forbidden' }, 403, origin);
        const priv = await getPrivateTenant(env, id);
        return json({ ok: true, tenants: priv ? [privateView(id, priv)] : [] }, 200, origin);
      }
      const map = await listPrivateTenants(env);
      const rows = Object.keys(map).map((id) => privateView(id, map[id], 'agency'));
      return json({ ok: true, tenants: rows, features: ['hqTags'] }, 200, origin);
    } catch (e) {
      console.warn('private profile read failed');
      return json({ ok: false, error: 'private_read_failed' }, 502, origin);
    }
  }

  if (action === 'delete') {
    const rawIds = Array.isArray(body.tenantIds) ? body.tenantIds : [body.tenantId];
    const ids = rawIds.map(safeId).filter(Boolean).slice(0, 20);
    if (!ids.length) return json({ ok: false, error: 'invalid_tenant' }, 400, origin);
    for (const id of ids) {
      if (!canWrite(session, id)) return json({ ok: false, error: 'forbidden' }, 403, origin);
    }
    for (const id of ids) await deleteTenant(env, id);
    return json({ ok: true, deleted: ids.length }, 200, origin);
  }

  if (action !== 'save') return json({ ok: false, error: 'not_found' }, 404, origin);

  const incoming = Array.isArray(body.tenants) ? body.tenants : (body.tenant ? [body.tenant] : []);
  if (!incoming.length || incoming.length > 40) {
    return json({ ok: false, error: 'invalid_profile' }, 400, origin);
  }
  const profiles = [];
  for (const raw of incoming) {
    const id = safeId(raw && (raw.id || raw.slug));
    if (!id) return json({ ok: false, error: 'invalid_tenant' }, 400, origin);
    if (!canWrite(session, id)) return json({ ok: false, error: 'forbidden' }, 403, origin);
    const profile = sanitizeProfile(raw, id);
    if (!profile) return json({ ok: false, error: 'invalid_profile' }, 400, origin);
    if (JSON.stringify(profile).length > 400000) {
      return json({ ok: false, error: 'profile_too_large' }, 400, origin);
    }
    profiles.push({ id, profile });
  }
  const ignoredFields = {};
  for (const row of profiles) {
    let ign;
    try {
      ign = await putTenant(env, row.id, row.profile, session.role);
    } catch (e) {
      if (String(e && e.message) === 'tenant_not_found') {
        return json({ ok: false, error: 'tenant_not_found' }, 404, origin);
      }
      throw e;
    }
    if (ign && ign.length) ignoredFields[row.id] = ign;
  }

  const savedIds = new Set(profiles.map((row) => row.id));
  const deleteIds = (Array.isArray(body.deleteIds) ? body.deleteIds : []).map(safeId).filter(Boolean).slice(0, 20);
  for (const id of deleteIds) {
    if (savedIds.has(id)) continue;
    if (!canWrite(session, id)) return json({ ok: false, error: 'forbidden' }, 403, origin);
  }
  let deleted = 0;
  for (const id of deleteIds) {
    if (savedIds.has(id)) continue;
    await deleteTenant(env, id);
    deleted += 1;
  }
  const out = { ok: true, saved: profiles.length, deleted };
  if (Object.keys(ignoredFields).length) out.ignoredFields = ignoredFields;
  return json(out, 200, origin);
}
