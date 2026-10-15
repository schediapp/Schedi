/**
 * Firestore access as the Firebase Admin service account.
 * Uses the worker secret FIREBASE_SERVICE_ACCOUNT_JSON.
 * Never log that value or the private key.
 */

const tokenCache = {};
const DEFAULT_SCOPE = 'https://www.googleapis.com/auth/datastore';

function b64urlBytes(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlJson(value) {
  return b64urlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function pemToPkcs8(pem) {
  const body = String(pem || '').replace(/-----BEGIN [^-]+-----/g, '').replace(/-----END [^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function readServiceAccount(env) {
  const raw = String((env && env.FIREBASE_SERVICE_ACCOUNT_JSON) || '').trim();
  if (!raw) throw new Error('firebase_admin_not_configured');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    throw new Error('firebase_admin_not_configured');
  }
  const email = String(parsed.client_email || '').trim();
  let privateKey = String(parsed.private_key || '');
  if (privateKey.includes('\\n')) privateKey = privateKey.replace(/\\n/g, '\n');
  if (!email || !privateKey.includes('BEGIN')) throw new Error('firebase_admin_not_configured');
  return { email, privateKey };
}

export async function adminAccessToken(env, scope) {
  scope = scope || DEFAULT_SCOPE;
  const now = Math.floor(Date.now() / 1000);
  const hit = tokenCache[scope];
  if (hit && hit.until - 60 > now) return hit.token;
  const account = readServiceAccount(env);
  const header = b64urlJson({ alg: 'RS256', typ: 'JWT' });
  const claim = b64urlJson({
    iss: account.email,
    sub: account.email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const unsigned = header + '.' + claim;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(account.privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const assertion = unsigned + '.' + b64urlBytes(new Uint8Array(sig));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + encodeURIComponent(assertion),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error('firebase_admin_token_failed:' + res.status);
  tokenCache[scope] = { token: data.access_token, until: now + (Number(data.expires_in) || 3600) };
  return data.access_token;
}

export async function adminAuthHeaders(env) {
  const token = await adminAccessToken(env);
  return { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
}
