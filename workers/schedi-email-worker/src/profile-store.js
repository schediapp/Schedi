/**
 * Owner and agency profile writes. Browser clients do not write Firestore.
 * The worker writes with the Firebase Admin service account, which bypasses rules.
 */
import { readSession, deleteOwnerSecret } from './owner-auth.js';
import { requireAgency } from './agency-session.js';
import { adminAuthHeaders } from './firebase-admin.js';
import {
  splitTenant,
  patchPrivateTenant,
  deletePrivateTenant,
  getPrivateTenant,
  listPrivateTenants,
  privateView,
  migrateTenantsToPrivate,
  AGENCY_ONLY_PRIVATE_KEYS,
  decodeDoc,
} from './tenant-private.js';
import { applyOwnerEntitlementLock } from './entitlements.js';

const FORBIDDEN = new Set([
  'ownerPassword',
  'appointments',
  'publicSlots',
  'clientName',
  'clientEmail',
  'clientPhone',
  'manageToken',
  '_privateBookingsLoaded',
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

function sanitizeProfile(raw, tenantId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const k of Object.keys(raw)) {
    if (!k || FORBIDDEN.has(k) || k.charAt(0) === '_') continue;
    if (raw[k] === undefined) continue;
    out[k] = raw[k];
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

/** Returns the list of owner-sent fields that were ignored by the plan/entitlement lock. */
async function putTenant(env, tenantId, profile, role) {
  // Owner contact + billing fields go to the private doc (merge, only keys present);
  // the world-readable public doc never receives them.
  const split = splitTenant(profile);
  let pub = split.pub;
  const priv = split.priv;
  const headers = await adminAuthHeaders(env);
  let ignored = [];
  if (role !== 'agency') {
    // Plan / entitlement lock: plan + subscriptionStatus keep their stored values, billing keys
    // (monthlyPrice, complimentaryPro, billingExempt, paymentForm, Stripe ids) are dropped, and
    // Pro-only features can't be switched on unless the stored plan is Pro (or complimentary Pro).
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
  }
  if (Object.keys(priv).length) await patchPrivateTenant(env, tenantId, priv);
  const fields = {};
  for (const k of Object.keys(pub)) fields[k] = encodeFirestoreValue(pub[k]);
  const res = await fetch(tenantsCollectionUrl(env) + '/' + encodeURIComponent(tenantId), {
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
