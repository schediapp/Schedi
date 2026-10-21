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
import { tenantPlanName } from './cancellation-fee.js';
import { BOOKING_PAGE_KEEP_FIELDS } from '../../../worker/booking-page-keep.js';

/**
 * Top-level tenant keys stored on the private doc.
 * `plan` is also rewritten onto the public doc as the customer-facing tier
 * (free, starter, or pro). The booking page and the unauthenticated web worker
 * cannot read the private doc, so that tier stays public. The canonical plan
 * copied here is what the owner, HQ, and the server read.
 * `subscriptionStatus` is private only. Public pause is `acceptingBookings`.
 */
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
  'cancelAtPeriodEnd',
  'currentPeriodEnd',
  'plan',
  'subscriptionStatus',
];
/** Kept on the public doc after it is copied to the private doc. */
export const PUBLIC_BOOKING_TIER_KEY = 'plan';
/** Worker bookkeeping. Private doc only, and never returned to the owner or agency UI. */
export const WORKER_ONLY_PRIVATE_KEYS = ['unpaidDigestWeek'];
/** notifications.replyTo (an email address) is stored privately as this key. */
export const PRIVATE_REPLY_TO_KEY = 'notificationsReplyTo';
/**
 * Square OAuth ciphertext and seller tokens. Private doc only.
 * Never returned by privateView and never merged onto the tenant object the browser can save.
 */
export const SQUARE_CONNECTION_KEY = 'squareConnection';
/** Billing keys only the agency (or the worker itself) may change. Owners can edit their contact info. */
export const AGENCY_ONLY_PRIVATE_KEYS = new Set([
  'stripeCustomerId',
  'stripeSubscriptionId',
  'billingExempt',
  'complimentaryPro',
  'monthlyPrice',
  'paymentForm',
  'hqTags',
  'cancelAtPeriodEnd',
  'currentPeriodEnd',
  'plan',
  'subscriptionStatus',
]);

/** Square seller ids belong on the private connection, not the world-readable doc. */
export const SQUARE_PUBLIC_ID_KEYS = [
  'squareMerchantId',
  'squareLocationId',
  'squareLocationName',
  'squareAccountName',
];

export const PUBLIC_ADDRESS_KEYS = [
  'address',
  'location',
  'businessAddress',
  'businessLocation',
  'city',
  'businessCity',
  'state',
  'businessState',
];

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
    if (PRIVATE_SET.has(k) || WORKER_ONLY_PRIVATE_KEYS.includes(k)) {
      priv[k] = tenant[k];
      continue;
    }
    if (k === PRIVATE_REPLY_TO_KEY || k === SQUARE_CONNECTION_KEY) {
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

function showAddress(tenant) {
  return !tenant || tenant.showPublicAddress !== false;
}

/**
 * Public booking doc plus the private remainder.
 * The public half keeps booking-page fields, the effective plan tier, and
 * acceptingBookings. It does not keep subscriptionStatus, plan prices, comp
 * flags, Square seller ids, or unpaid-digest bookkeeping. The street address
 * is dropped when the owner hid it.
 * acceptingBookings is written on every public save. Older docs may omit it;
 * the booking page then falls back to subscriptionStatus === 'paused'.
 */
export function shapePublicBookingFields(tenant) {
  const { pub, priv } = splitTenant(tenant || {});
  for (const key of SQUARE_PUBLIC_ID_KEYS) delete pub[key];
  for (const key of WORKER_ONLY_PRIVATE_KEYS) delete pub[key];
  pub.plan = tenantPlanName(tenant || {});
  pub.acceptingBookings = String((tenant && tenant.subscriptionStatus) || '') !== 'paused' && (tenant ? tenant.acceptingBookings !== false : true);
  if (!showAddress(pub)) {
    for (const key of PUBLIC_ADDRESS_KEYS) delete pub[key];
  }
  return { pub, priv };
}

/**
 * Partial public write. Does not invent plan or address from a patch that
 * did not mention them. subscriptionStatus is stored privately and removed
 * from the public doc. The patch also sets acceptingBookings.
 */
export function shapePublicPatch(rawPatch) {
  const patch = rawPatch || {};
  const { pub, priv } = splitTenant(patch);
  for (const key of SQUARE_PUBLIC_ID_KEYS) delete pub[key];
  for (const key of WORKER_ONLY_PRIVATE_KEYS) delete pub[key];
  if (Object.prototype.hasOwnProperty.call(patch, 'subscriptionStatus')) {
    pub.acceptingBookings = String(patch.subscriptionStatus || '') !== 'paused';
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'complimentaryPro') || Object.prototype.hasOwnProperty.call(patch, 'billingExempt') || Object.prototype.hasOwnProperty.call(patch, 'plan') || Object.prototype.hasOwnProperty.call(patch, 'monthlyPrice')) {
    pub.plan = tenantPlanName(Object.assign({}, patch));
  }
  const drop = [];
  for (const key of SQUARE_PUBLIC_ID_KEYS.concat(WORKER_ONLY_PRIVATE_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) drop.push(key);
  }
  for (const key of PRIVATE_TENANT_KEYS) {
    if (key === PUBLIC_BOOKING_TIER_KEY) continue;
    if (Object.prototype.hasOwnProperty.call(patch, key)) drop.push(key);
  }
  if (patch.showPublicAddress === false) {
    for (const key of PUBLIC_ADDRESS_KEYS) {
      delete pub[key];
      drop.push(key);
    }
  }
  return { pub, priv, drop };
}

const BOOKING_KEEP = new Set(BOOKING_PAGE_KEEP_FIELDS);

/** Names that a dry-run cleanup should remove from an existing public doc. */
export function publicFieldsToTrim(pubTenant) {
  const paths = privatePathsOnPublic(pubTenant);
  const pub = pubTenant || {};
  for (const key of SQUARE_PUBLIC_ID_KEYS.concat(WORKER_ONLY_PRIVATE_KEYS)) {
    if (Object.prototype.hasOwnProperty.call(pub, key) && paths.indexOf(key) < 0) paths.push(key);
  }
  if (pub.showPublicAddress === false) {
    for (const key of PUBLIC_ADDRESS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(pub, key) && paths.indexOf(key) < 0) paths.push(key);
    }
  }
  return paths.filter((path) => PUBLIC_ADDRESS_KEYS.includes(path) || !BOOKING_KEEP.has(path));
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
  for (const k of WORKER_ONLY_PRIVATE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(priv, k)) tenant[k] = priv[k];
  }
  return tenant;
}

/** Private fields as a plain object (for /api/profile action:"private"). */
export function privateView(id, priv, role) {
  const out = { id };
  for (const k of PRIVATE_TENANT_KEYS) {
    if (k === 'hqTags' && role !== 'agency') continue; // HQ-only notes never go to owners
    if (WORKER_ONLY_PRIVATE_KEYS.includes(k)) continue;
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
  const keys = Object.keys(priv || {}).filter((k) => priv[k] !== undefined && (PRIVATE_SET.has(k) || WORKER_ONLY_PRIVATE_KEYS.includes(k) || k === PRIVATE_REPLY_TO_KEY || k === SQUARE_CONNECTION_KEY));
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

/** Merge-write a few public fields without replacing the rest of the tenant doc. */
export async function patchPublicFields(env, tenantId, fields) {
  const id = safeId(tenantId);
  const keys = Object.keys(fields || {}).filter((k) => fields[k] !== undefined);
  if (!id || !keys.length) return { ok: true, written: 0 };
  const qs = keys.map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const encoded = {};
  for (const k of keys) encoded[k] = encodeValue(fields[k]);
  const headers = await adminAuthHeaders(env);
  const res = await fetch(publicTenantsUrl(env) + '/' + encodeURIComponent(id) + '?' + qs, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: encoded }),
  });
  if (!res.ok) throw new Error('public_field_patch_failed:' + res.status);
  return { ok: true, written: keys.length };
}

/** Delete named fields from the private tenant doc. */
export async function deletePrivateFields(env, tenantId, fieldPaths) {
  const id = safeId(tenantId);
  if (!id || !fieldPaths || !fieldPaths.length) return;
  const qs = fieldPaths.map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&')
    + '&currentDocument.exists=true';
  const headers = await adminAuthHeaders(env);
  const res = await fetch(privateTenantsUrl(env) + '/' + encodeURIComponent(id) + '?' + qs, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ fields: {} }),
  });
  if (!res.ok && res.status !== 404) throw new Error('private_field_delete_failed:' + res.status);
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
    if (k === PUBLIC_BOOKING_TIER_KEY) continue;
    if (pubTenant && Object.prototype.hasOwnProperty.call(pubTenant, k)) paths.push(k);
  }
  const notes = pubTenant && pubTenant.notifications;
  if (notes && typeof notes === 'object' && Object.prototype.hasOwnProperty.call(notes, 'replyTo')) paths.push('notifications.replyTo');
  return paths;
}

function sameValue(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
}

function privateHasKey(doc, key) {
  return !!doc && Object.prototype.hasOwnProperty.call(doc, key);
}

/** Public field path that delete uses, mapped to the key stored on the private doc. */
function privateKeyForRemovePath(path) {
  if (path === 'notifications.replyTo') return PRIVATE_REPLY_TO_KEY;
  return path;
}

/**
 * What one public tenant doc needs: copy private fields the private doc does
 * not already have, write publicPatch (effective plan and acceptingBookings)
 * on the public doc, then remove `remove` from the public doc. Keys already
 * on the private doc stay as they are (including empty string and null).
 * The effective plan is not removed.
 */
export function planTenantPrivateMove(pubTenant, existingPrivate) {
  const pub = pubTenant || {};
  const existing = existingPrivate || {};
  const shaped = shapePublicBookingFields(pub);
  const copy = {};
  const kept = [];
  for (const key of Object.keys(shaped.priv)) {
    if (shaped.priv[key] === undefined) continue;
    if (privateHasKey(existing, key)) {
      kept.push(key);
      continue;
    }
    copy[key] = shaped.priv[key];
  }
  const remove = privatePathsOnPublic(pub);
  const publicPatch = {};
  if (shaped.pub.plan != null && shaped.pub.plan !== pub.plan) publicPatch.plan = shaped.pub.plan;
  const status = privateHasKey(existing, 'subscriptionStatus') ? existing.subscriptionStatus : pub.subscriptionStatus;
  const acceptingBookings = String(status || '') !== 'paused' && pub.acceptingBookings !== false;
  if (remove.indexOf('subscriptionStatus') >= 0 && pub.acceptingBookings !== acceptingBookings) {
    publicPatch.acceptingBookings = acceptingBookings;
  }
  return { copy, kept, remove, publicPatch };
}

/**
 * Copy missing keys, verify the private doc, write the public booking flags, then delete.
 * Verify runs whenever a public field would be deleted, including when nothing is copied.
 * Copied values must match. Every field about to be deleted must already exist on the
 * private doc. A failed verify does not delete. io: { copy, read, publicPatch, remove }.
 */
export async function runTenantPrivateMove(id, plan, io) {
  const steps = [];
  const copyKeys = Object.keys((plan && plan.copy) || {});
  const remove = (plan && plan.remove) || [];
  if (copyKeys.length) {
    steps.push('copy');
    await io.copy(id, plan.copy);
  }
  if (copyKeys.length || remove.length) {
    steps.push('verify');
    const check = await io.read(id);
    const mismatched = copyKeys.filter((k) => !check || !sameValue(check[k], plan.copy[k]));
    const missing = remove
      .map(privateKeyForRemovePath)
      .filter((k) => !check || !Object.prototype.hasOwnProperty.call(check, k));
    if (mismatched.length || missing.length) {
      return { ok: false, steps, error: 'verify_failed', mismatched, missing };
    }
  }
  const patchKeys = Object.keys((plan && plan.publicPatch) || {});
  if (patchKeys.length) {
    steps.push('publicPatch');
    await io.publicPatch(id, plan.publicPatch);
  }
  if (remove.length) {
    steps.push('delete');
    await io.remove(id, remove);
  }
  return { ok: true, steps };
}

/**
 * One-time (idempotent) migration. Reads the private doc first. Copies only keys
 * it does not already have, re-reads and verifies, writes acceptingBookings (and a
 * corrected public plan tier), then deletes the private fields from the public doc.
 * The customer-facing plan stays. A key already stored privately is left alone,
 * including empty string and null. Delete runs only after that verify succeeds.
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
    const existing = await getPrivateTenant(env, id);
    const move = planTenantPrivateMove(pub, existing || {});
    const row = {
      id,
      publicPrivatePaths: move.remove,
      copied: Object.keys(move.copy),
      kept: move.kept,
      publicPatch: move.publicPatch,
      remove: move.remove,
      verified: false,
      publicCleaned: false,
    };
    if (!row.copied.length && !move.remove.length && !Object.keys(move.publicPatch).length) {
      row.note = 'already clean';
      report.push(row);
      continue;
    }
    if (opts.dryRun) {
      row.note = 'dry run';
      report.push(row);
      continue;
    }
    const applied = await runTenantPrivateMove(id, move, {
      copy: (tenantId, priv) => patchPrivateTenant(env, tenantId, priv),
      read: (tenantId) => getPrivateTenant(env, tenantId),
      publicPatch: (tenantId, fields) => patchPublicFields(env, tenantId, fields),
      remove: (tenantId, paths) => deletePublicPrivateFields(env, tenantId, paths),
    });
    row.steps = applied.steps;
    if (!applied.ok) {
      row.error = applied.error;
      row.mismatched = applied.mismatched;
      report.push(row);
      continue;
    }
    row.verified = applied.steps.indexOf('verify') >= 0;
    row.publicCleaned = applied.steps.indexOf('delete') >= 0;
    report.push(row);
  }
  return { ok: report.every((r) => !r.error), dryRun: !!opts.dryRun, tenants: report.length, report };
}
