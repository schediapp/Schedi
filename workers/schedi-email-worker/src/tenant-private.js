/**
 * Owner-private tenant fields.
 *
 * Public booking-page data lives at   artifacts/{appId}/public/data/tenants/{slug}   (world-readable).
 * Owner contact + billing data lives at artifacts/{appId}/private/data/tenants/{slug} (rules: deny all;
 * only the worker's Firebase Admin service account can read/write it, because Admin bypasses rules).
 *
 * The browser never reads the private path. Signed-in owners/agency get their private fields through
 * POST /api/profile {action:"private", session}. Workers code that needs them goes through
 * getTenantById/listAllTenants, which merge the private doc back in.
 */
import { adminAuthHeaders } from './firebase-admin.js';

/** Top-level tenant keys that must never be on the public doc. */
export const PRIVATE_TENANT_KEYS = [
  'ownerName',
  'ownerEmail',
  'ownerPhone',
  'stripeCustomerId',
  'stripeSubscriptionId',
  'billingExempt',
  'complimentaryPro',
  'monthlyPrice',
  'paymentForm',
  'hqTags',
];
/** notifications.replyTo (an email address) is stored privately as this key. */
export const PRIVATE_REPLY_TO_KEY = 'notificationsReplyTo';
/** Billing keys only the agency (or the worker itself) may change. Owners can edit their contact info. */
export const AGENCY_ONLY_PRIVATE_KEYS = new Set([
  'stripeCustomerId',
  'stripeSubscriptionId',
  'billingExempt',
  'complimentaryPro',
  'monthlyPrice',
  'paymentForm',
  'hqTags',
]);

const PRIVATE_SET = new Set(PRIVATE_TENANT_KEYS);

function projectBits(env) {
  return {
    projectId: String((env && env.FIREBASE_PROJECT_ID) || 'siteforge-97699').trim(),
    appId: String((env && env.FIREBASE_APP_ID) || 'siteforge-97699').trim(),
  };
}

function docsRoot(env) {
  const { projectId } = projectBits(env);
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}

export function publicTenantsUrl(env) {
  const { appId } = projectBits(env);
  return `${docsRoot(env)}/artifacts/${appId}/public/data/tenants`;
}

export function privateTenantsUrl(env) {
  const { appId } = projectBits(env);
  return `${docsRoot(env)}/artifacts/${appId}/private/data/tenants`;
}

function safeId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : '';
}

export function decodeValue(v) {
  if (!v || typeof v !== 'object') return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) {
    const o = {};
    const f = v.mapValue.fields || {};
    for (const k of Object.keys(f)) o[k] = decodeValue(f[k]);
    return o;
  }
  return null;
}

export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) if (v[k] !== undefined) fields[k] = encodeValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

export function decodeDoc(doc) {
  const out = {};
  const fields = (doc && doc.fields) || {};
  for (const k of Object.keys(fields)) out[k] = decodeValue(fields[k]);
  return out;
}

/**
 * Split a full tenant object into { pub, priv }.
 * pub: safe for the world-readable doc. priv: only keys actually present in the input
 * (so a partial save never wipes private values it didn't carry).
 */
export function splitTenant(tenant) {
  const pub = {};
  const priv = {};
  for (const k of Object.keys(tenant || {})) {
    if (tenant[k] === undefined) continue;
    if (PRIVATE_SET.has(k)) {
      priv[k] = tenant[k];
      continue;
    }
    if (k === PRIVATE_REPLY_TO_KEY) {
      priv[k] = tenant[k];
      continue;
    }
    if (k === 'notifications' && tenant[k] && typeof tenant[k] === 'object' && !Array.isArray(tenant[k])) {
      const notes = Object.assign({}, tenant[k]);
      if (Object.prototype.hasOwnProperty.call(notes, 'replyTo')) {
        priv[PRIVATE_REPLY_TO_KEY] = String(notes.replyTo == null ? '' : notes.replyTo);
        delete notes.replyTo;
      }
      pub[k] = notes;
      continue;
    }
    pub[k] = tenant[k];
  }
  return { pub, priv };
}

/** Overlay private fields onto a (public) tenant object, in place. */
export function mergePrivateInto(tenant, priv) {
  if (!tenant || !priv) return tenant;
  for (const k of PRIVATE_TENANT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(priv, k)) tenant[k] = priv[k];
  }
  if (Object.prototype.hasOwnProperty.call(priv, PRIVATE_REPLY_TO_KEY)) {
    const notes = tenant.notifications && typeof tenant.notifications === 'object' ? tenant.notifications : {};
    tenant.notifications = Object.assign({}, notes, { replyTo: priv[PRIVATE_REPLY_TO_KEY] || '' });
  }
  return tenant;
}

/** Private fields as a plain object (for /api/profile action:"private"). */
export function privateView(id, priv, role) {
  const out = { id };
  for (const k of PRIVATE_TENANT_KEYS) {
    if (k === 'hqTags' && role !== 'agency') continue; // HQ-only notes never go to owners
    if (priv && Object.prototype.hasOwnProperty.call(priv, k)) out[k] = priv[k];
  }
  if (priv && Object.prototype.hasOwnProperty.call(priv, PRIVATE_REPLY_TO_KEY)) out[PRIVATE_REPLY_TO_KEY] = priv[PRIVATE_REPLY_TO_KEY];
  return out;
}

export async function getPrivateTenant(env, tenantId) {
  const id = safeId(tenantId);
  if (!id) return null;
  const headers = await adminAuthHeaders(env);
  const res = await fetch(privateTenantsUrl(env) + '/' + encodeURIComponent(id), {
    headers: { Authorization: headers.Authorization },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('private_tenant_read_failed:' + res.status);
  const data = await res.json().catch(() => null);
  return decodeDoc(data);
}

export async function listPrivateTenants(env) {
  const headers = await adminAuthHeaders(env);
  const map = {};
  let pageToken = '';
  let pages = 0;
  do {
    const url = privateTenantsUrl(env) + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: headers.Authorization } });
    if (res.status === 404) break;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('private_tenant_list_failed:' + res.status);
    for (const doc of data.documents || []) {
      const id = String(doc.name || '').split('/').pop();
      if (id) map[id] = decodeDoc(doc);
    }
    pageToken = data.nextPageToken || '';
    pages++;
  } while (pageToken && pages < 20);
  return map;
}

/** Merge-write private fields (only the keys given). Creates the doc if missing. */
export async function patchPrivateTenant(env, tenantId, priv) {
  const id = safeId(tenantId);
  if (!id) throw new Error('invalid_tenant');
  const keys = Object.keys(priv || {}).filter((k) => priv[k] !== undefined && (PRIVATE_SET.has(k) || k === PRIVATE_REPLY_TO_KEY));
  if (!keys.length) return { ok: true, written: 0 };
  const body = {};
  for (const k of keys) body[k] = priv[k];
  body.tenantId = id;
  body.privateUpdatedAt = new Date().toISOString();
  const allKeys = Object.keys(body);
  const qs = allKeys.map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const fields = {};
  for (const k of allKeys) fields[k] = encodeValue(body[k]);
  const headers = await adminAuthHeaders(env);
  const res = await fetch(privateTenantsUrl(env) + '/' + encodeURIComponent(id) + '?' + qs, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) {
    console.warn('private tenant write failed', res.status);
    throw new Error('private_tenant_write_failed:' + res.status);
  }
  return { ok: true, written: keys.length };
}

export async function deletePrivateTenant(env, tenantId) {
  const id = safeId(tenantId);
  if (!id) return;
  const headers = await adminAuthHeaders(env);
  const res = await fetch(privateTenantsUrl(env) + '/' + encodeURIComponent(id), {
    method: 'DELETE',
    headers: { Authorization: headers.Authorization },
  });
  if (!res.ok && res.status !== 404) throw new Error('private_tenant_delete_failed:' + res.status);
}

/** Remove private keys from the public doc (REST equivalent of FieldValue.delete()). */
export async function deletePublicPrivateFields(env, tenantId, fieldPaths) {
  const id = safeId(tenantId);
  if (!id || !fieldPaths || !fieldPaths.length) return;
  const qs = fieldPaths.map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&')
    + '&currentDocument.exists=true';
  const headers = await adminAuthHeaders(env);
  const res = await fetch(publicTenantsUrl(env) + '/' + encodeURIComponent(id) + '?' + qs, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: {} }),
  });
  if (!res.ok) throw new Error('public_field_delete_failed:' + res.status);
}

/** Field paths on a decoded public tenant that are private and must be removed. */
export function privatePathsOnPublic(pubTenant) {
  const paths = [];
  for (const k of PRIVATE_TENANT_KEYS) {
    if (pubTenant && Object.prototype.hasOwnProperty.call(pubTenant, k)) paths.push(k);
  }
  const notes = pubTenant && pubTenant.notifications;
  if (notes && typeof notes === 'object' && Object.prototype.hasOwnProperty.call(notes, 'replyTo')) paths.push('notifications.replyTo');
  return paths;
}

function sameValue(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

/**
 * One-time (idempotent) migration: copy private fields from each public tenant doc to the private doc,
 * re-read and verify, then delete them from the public doc. Values already in the private doc are kept
 * unless the public doc holds the field (public value is the one the site was using).
 */
export async function migrateTenantsToPrivate(env, opts) {
  opts = opts || {};
  const headers = await adminAuthHeaders(env);
  const report = [];
  let pageToken = '';
  const docs = [];
  do {
    const url = publicTenantsUrl(env) + '?pageSize=300' + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    const res = await fetch(url, { headers: { Authorization: headers.Authorization } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('public_list_failed:' + res.status);
    for (const d of data.documents || []) docs.push(d);
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  for (const doc of docs) {
    const id = String(doc.name || '').split('/').pop();
    const pub = decodeDoc(doc);
    const paths = privatePathsOnPublic(pub);
    const row = { id, publicPrivatePaths: paths, copied: [], verified: false, publicCleaned: false };
    if (!paths.length) {
      row.note = 'already clean';
      report.push(row);
      continue;
    }
    const { priv } = splitTenant(pub);
    row.copied = Object.keys(priv);
    if (opts.dryRun) {
      row.note = 'dry run';
      report.push(row);
      continue;
    }
    await patchPrivateTenant(env, id, priv);
    const check = await getPrivateTenant(env, id);
    const mismatched = Object.keys(priv).filter((k) => !check || !sameValue(check[k], priv[k]));
    if (mismatched.length) {
      row.error = 'verify_failed';
      row.mismatched = mismatched;
      report.push(row);
      continue;
    }
    row.verified = true;
    await deletePublicPrivateFields(env, id, paths);
    row.publicCleaned = true;
    report.push(row);
  }
  return { ok: report.every((r) => !r.error), dryRun: !!opts.dryRun, tenants: report.length, report };
}
