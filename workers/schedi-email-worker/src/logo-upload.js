/**
 * Owner logo storage.
 * POST /api/business-logo (and /api/logo-upload) stores one square logo per
 * business, a service image, or a booking QR. DELETE, or POST { remove: true },
 * deletes that business's logo only.
 * GET /logos/{tenantId} serves the file. The public URL includes ?v= so a
 * replace is a new address and cached copies of the previous file stay put.
 *
 * Needs LOGO_BUCKET (R2). No public bucket hostname. Until the binding is
 * present, upload returns logo_storage_unconfigured and the page keeps the
 * paste-a-link field. A missing object is a 404 so the page can fall back.
 */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

export function sniffLogo(bytes) {
  if (!bytes || bytes.length < 8 || bytes.length > LOGO_MAX_BYTES) return '';
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 400)).replace(/^\uFEFF/, '').trim().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  return '';
}

export function sanitizeLogoSvg(source) {
  let text = String(source || '').replace(/^\uFEFF/, '').trim();
  if (!text || text.length > LOGO_MAX_BYTES) return { ok: false, error: 'svg_rejected' };
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  text = text.replace(/<\?xml[\s\S]*?\?>/gi, '').trim();
  if (/<!|<\?/.test(text)) return { ok: false, error: 'svg_rejected' };
  if (/<\s*(\/?)\s*(script|foreignobject|iframe|embed|object|image|use|set|animate|animatetransform|animatemotion|handler|mpath)\b/i.test(text)) {
    return { ok: false, error: 'svg_rejected' };
  }
  if (/\son[a-z]+\s*=/i.test(text)) return { ok: false, error: 'svg_rejected' };
  if (/javascript:|vbscript:|data:/i.test(text)) return { ok: false, error: 'svg_rejected' };
  const withoutNamespace = text.replace(/\sxmlns(?::[a-z0-9]+)?\s*=\s*["']http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink)["']/gi, '');
  if (/https?:/i.test(withoutNamespace)) return { ok: false, error: 'svg_rejected' };
  if (!/^<svg[\s>]/i.test(text) || !/<\/svg>\s*$/i.test(text)) return { ok: false, error: 'svg_rejected' };
  if (!/\sxmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/i.test(text)) {
    text = text.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  return { ok: true, svg: text };
}

function decodeBase64(data) {
  const clean = String(data || '').replace(/\s/g, '');
  if (!clean || clean.length > Math.ceil(LOGO_MAX_BYTES * 1.4) || !/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null;
  let bin = '';
  try { bin = atob(clean); } catch (_) { return null; }
  if (bin.length > LOGO_MAX_BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 255;
  return bytes;
}

function safeTenantId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return '';
  return id;
}

// Agency HQ manages the businesses in artifacts/{app}/public/data/tenants.
// schedi-web can read that directory without the Firebase admin secret.
// A listed business is a document that exists there. Anything else is refused.
export async function agencyListedTenant(env, tenantId) {
  const id = safeTenantId(tenantId);
  const projectId = String((env && env.FIREBASE_PROJECT_ID) || '').trim();
  const appId = String((env && env.FIREBASE_APP_ID) || projectId).trim();
  if (!id || !/^[a-z0-9-]+$/i.test(projectId) || !/^[a-z0-9-]+$/i.test(appId)) return false;
  const url = 'https://firestore.googleapis.com/v1/projects/' + projectId
    + '/databases/(default)/documents/artifacts/' + appId
    + '/public/data/tenants/' + encodeURIComponent(id)
    + '?mask.fieldPaths=name';
  try {
    const res = await fetch(url);
    try { await res.arrayBuffer(); } catch (_) {}
    return res.ok === true;
  } catch (_) {
    return false;
  }
}

function safeServiceId(value) {
  if (value == null || String(value).trim() === '') return '';
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  return id;
}

const READ_EXT = ['png', 'jpg', 'webp', 'svg'];

function logoBucket(env) {
  const bucket = env && env.LOGO_BUCKET;
  if (!bucket || typeof bucket.put !== 'function') return null;
  return bucket;
}

function logoVersion() {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function serveOrigin(request) {
  try {
    const origin = new URL(request.url).origin;
    if (origin === 'https://schedi.app' || origin === 'https://www.schedi.app') return 'https://schedi.app';
    if (/^https:\/\//i.test(origin)) return origin;
  } catch (_) {}
  return 'https://schedi.app';
}

export function parseLogoPath(pathname) {
  const parts = String(pathname || '').split('/').filter(Boolean);
  if (parts[0] !== 'logos' || parts.length < 2) return null;
  const tenantId = safeTenantId(decodePathPart(parts[1]));
  if (!tenantId) return null;
  if (parts.length === 2) return { tenantId: tenantId, kind: 'logo' };
  if (parts.length === 3 && parts[2] === 'qr') return { tenantId: tenantId, kind: 'qr' };
  if (parts.length === 4 && parts[2] === 'services') {
    const serviceId = safeServiceId(decodePathPart(parts[3]));
    if (!serviceId) return null;
    return { tenantId: tenantId, kind: 'service', serviceId: serviceId };
  }
  return null;
}

function decodePathPart(value) {
  try { return decodeURIComponent(String(value || '')); } catch (_) { return ''; }
}

function logoStem(parsed) {
  if (parsed.kind === 'qr') return 'logos/' + parsed.tenantId + '/qr.';
  if (parsed.kind === 'service') return 'logos/' + parsed.tenantId + '/services/' + parsed.serviceId + '.';
  return 'logos/' + parsed.tenantId + '.';
}

function publicLogoPath(parsed) {
  if (parsed.kind === 'qr') return '/logos/' + parsed.tenantId + '/qr';
  if (parsed.kind === 'service') return '/logos/' + parsed.tenantId + '/services/' + parsed.serviceId;
  return '/logos/' + parsed.tenantId;
}

function logoReadHeaders(contentType, versioned) {
  const headers = new Headers();
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cache-Control', versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=60');
  headers.set('X-Robots-Tag', 'noindex');
  if (contentType) headers.set('Content-Type', contentType);
  return headers;
}

async function deleteStem(bucket, stem, keepExt) {
  if (!bucket || typeof bucket.delete !== 'function') return;
  for (const other of Object.values(EXT)) {
    if (other === keepExt) continue;
    try { await bucket.delete(stem + other); } catch (_) {}
  }
}

async function removeBusinessLogo(bucket, tenantId) {
  await deleteStem(bucket, 'logos/' + tenantId + '.', '');
}

export async function handleLogoGet(request, env) {
  const url = new URL(request.url);
  const parsed = parseLogoPath(url.pathname);
  const headers404 = logoReadHeaders('text/plain; charset=utf-8', false);
  headers404.set('Cache-Control', 'no-store');
  if (!parsed) return new Response(request.method === 'HEAD' ? null : 'Not found\n', { status: 404, headers: headers404 });
  const bucket = env && env.LOGO_BUCKET;
  if (!bucket || typeof bucket.get !== 'function') return new Response(request.method === 'HEAD' ? null : 'Not found\n', { status: 404, headers: headers404 });
  const stem = logoStem(parsed);
  let found = null;
  let foundExt = '';
  for (let i = 0; i < READ_EXT.length; i++) {
    const ext = READ_EXT[i];
    let obj = null;
    try { obj = await bucket.get(stem + ext); } catch (_) { obj = null; }
    if (obj) { found = obj; foundExt = ext; break; }
  }
  if (!found) return new Response(request.method === 'HEAD' ? null : 'Not found\n', { status: 404, headers: headers404 });
  const versioned = /^[a-f0-9]{18}$/.test(String(url.searchParams.get('v') || ''));
  const storedType = found.httpMetadata && found.httpMetadata.contentType;
  const type = storedType || (
    foundExt === 'png' ? 'image/png'
      : foundExt === 'jpg' ? 'image/jpeg'
        : foundExt === 'webp' ? 'image/webp'
          : 'image/svg+xml'
  );
  const headers = logoReadHeaders(type || 'application/octet-stream', versioned);
  if (foundExt === 'svg' || String(type).indexOf('svg') !== -1) {
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: headers });
  const body = found.body != null ? found.body : found;
  return new Response(body, { status: 200, headers: headers });
}

export async function handleLogoUpload(request, env, origin, deps) {
  const respond = deps.json;
  const allowed = deps.isAllowedOrigin;
  const readSession = deps && deps.readSession;
  if (typeof readSession !== 'function') return respond({ ok: false, error: 'session_required' }, 401, origin);
  if (request.method !== 'POST' && request.method !== 'DELETE') return respond({ ok: false, error: 'method_not_allowed' }, 405, origin);
  if (origin && !allowed(origin)) return respond({ ok: false, error: 'origin_not_allowed' }, 403, origin);
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const session = await readSession(env, body && body.session);
  if (session && session.expired === true && session.role === 'owner') {
    return respond({ ok: false, error: 'session_expired' }, 401, origin);
  }
  if (!session || (session.role !== 'owner' && session.role !== 'agency')) {
    return respond({ ok: false, error: 'session_required' }, 401, origin);
  }
  let tenantId = '';
  if (session.role === 'owner') {
    tenantId = safeTenantId(session.tenantId);
    if (!tenantId) return respond({ ok: false, error: 'session_required' }, 401, origin);
  } else {
    tenantId = safeTenantId(body && body.tenantId);
    if (!tenantId) return respond({ ok: false, error: 'session_required' }, 401, origin);
    const owns = deps && typeof deps.agencyOwnsTenant === 'function' ? deps.agencyOwnsTenant : agencyListedTenant;
    let listed = false;
    try { listed = (await owns(env, tenantId)) === true; } catch (_) { listed = false; }
    if (!listed) return respond({ ok: false, error: 'forbidden' }, 403, origin);
  }
  const bucket = logoBucket(env);
  if (!bucket) return respond({ ok: false, error: 'logo_storage_unconfigured' }, 503, origin);
  if (request.method === 'DELETE' || (body && body.remove === true)) {
    await removeBusinessLogo(bucket, tenantId);
    return respond({ ok: true, url: '' }, 200, origin);
  }
  const bytes = decodeBase64(body && body.data);
  if (!bytes) return respond({ ok: false, error: 'too_large' }, 400, origin);
  const kind = sniffLogo(bytes);
  if (!kind || !EXT[kind]) return respond({ ok: false, error: 'bad_type' }, 400, origin);
  let payload = bytes;
  let contentType = kind;
  if (kind === 'image/svg+xml') {
    const cleaned = sanitizeLogoSvg(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
    if (!cleaned.ok) return respond({ ok: false, error: cleaned.error || 'svg_rejected' }, 400, origin);
    payload = new TextEncoder().encode(cleaned.svg);
    contentType = 'image/svg+xml; charset=utf-8';
  }
  const purpose = body && body.purpose === 'qr' ? 'qr' : '';
  if (body && body.purpose && purpose !== 'qr') return respond({ ok: false, error: 'bad_type' }, 400, origin);
  if (purpose === 'qr' && kind !== 'image/png' && kind !== 'image/jpeg' && kind !== 'image/svg+xml') {
    return respond({ ok: false, error: 'bad_type' }, 400, origin);
  }
  const serviceId = purpose === 'qr' ? '' : safeServiceId(body && body.serviceId);
  if (serviceId === null) return respond({ ok: false, error: 'bad_service' }, 400, origin);
  const ext = EXT[kind];
  const parsed = purpose === 'qr'
    ? { tenantId: tenantId, kind: 'qr' }
    : serviceId
      ? { tenantId: tenantId, kind: 'service', serviceId: serviceId }
      : { tenantId: tenantId, kind: 'logo' };
  const key = logoStem(parsed) + ext;
  const version = logoVersion();
  try {
    await bucket.put(key, payload, {
      httpMetadata: { contentType: contentType, cacheControl: 'public, max-age=60' },
      customMetadata: { version: version },
    });
  } catch (err) {
    console.error(JSON.stringify({
      message: 'logo put failed',
      tenantId: tenantId,
      error: err && err.message ? String(err.message).slice(0, 200) : 'put_failed',
    }));
    return respond({ ok: false, error: 'logo_write_failed' }, 500, origin);
  }
  await deleteStem(bucket, logoStem(parsed), ext);
  return respond({ ok: true, url: serveOrigin(request) + publicLogoPath(parsed) + '?v=' + version }, 200, origin);
}
