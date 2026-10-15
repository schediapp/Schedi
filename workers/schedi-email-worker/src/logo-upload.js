/**
 * POST /api/logo-upload
 * Owner session required. Stores one square logo per business, or one
 * square image per service when serviceId is set
 * (logos/{tenantId}/services/{serviceId}.{ext}).
 *
 * Needs both of these before a real upload succeeds:
 *   LOGO_BUCKET       R2 binding (bucket name schedi-logos)
 *   LOGO_PUBLIC_BASE  https origin that serves that bucket, no trailing path
 * Until both are set, the handler returns logo_storage_unconfigured and the
 * portal keeps the paste-a-link field.
 */
import { readSession as readOwnerSession } from './owner-auth.js';

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

function safeServiceId(value) {
  if (value == null || String(value).trim() === '') return '';
  const id = String(value).trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  return id;
}

export async function handleLogoUpload(request, env, origin, deps) {
  const respond = deps.json;
  const allowed = deps.isAllowedOrigin;
  const readSession = deps.readSession || readOwnerSession;
  if (request.method !== 'POST') return respond({ ok: false, error: 'method_not_allowed' }, 405, origin);
  if (origin && !allowed(origin)) return respond({ ok: false, error: 'origin_not_allowed' }, 403, origin);
  let body = {};
  try { body = await request.json(); } catch (_) { body = {}; }
  const session = await readSession(env, body && body.session);
  if (!session || session.role !== 'owner') return respond({ ok: false, error: 'session_required' }, 401, origin);
  const tenantId = safeTenantId(session.tenantId);
  if (!tenantId) return respond({ ok: false, error: 'session_required' }, 401, origin);
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
  const serviceId = safeServiceId(body && body.serviceId);
  if (serviceId === null) return respond({ ok: false, error: 'bad_service' }, 400, origin);
  const bucket = env && env.LOGO_BUCKET;
  const base = String(env && env.LOGO_PUBLIC_BASE || '').replace(/\/+$/, '');
  if (!bucket || typeof bucket.put !== 'function' || !/^https:\/\/[^\s]+$/i.test(base)) {
    return respond({ ok: false, error: 'logo_storage_unconfigured' }, 503, origin);
  }
  const ext = EXT[kind];
  const key = serviceId
    ? 'logos/' + tenantId + '/services/' + serviceId + '.' + ext
    : 'logos/' + tenantId + '.' + ext;
  await bucket.put(key, payload, {
    httpMetadata: { contentType: contentType, cacheControl: 'public, max-age=86400' },
  });
  if (typeof bucket.delete === 'function') {
    const stem = serviceId
      ? 'logos/' + tenantId + '/services/' + serviceId + '.'
      : 'logos/' + tenantId + '.';
    for (const other of Object.values(EXT)) {
      if (other === ext) continue;
      try { await bucket.delete(stem + other); } catch (_) {}
    }
  }
  return respond({ ok: true, url: base + '/' + key }, 200, origin);
}
