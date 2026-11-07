import { createHmac, timingSafeEqual } from "node:crypto";

/** Browser cookie lifetime. The signature expires on the same bound. */
export const OWNER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const PREFIX = "s2";

export interface OwnerSessionClaims {
  sid: string;
  ownerId: string;
  exp: number;
}

function key(secret: string): string {
  return `schedi-owner-session-v2\n${secret}`;
}

function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", key(secret)).update(payload).digest("base64url");
}

/**
 * Cookie value bound to one owner and one server-side session id.
 * The paid-callback secret is mixed with a fixed label so the cookie is not that secret.
 */
export function signOwnerSession(claims: OwnerSessionClaims, secret: string, nowMs = Date.now()): string {
  const expected = String(secret || "");
  if (!expected) throw new Error("Connect session secret is not set.");
  if (!/^[A-Za-z0-9_-]{43}$/.test(claims.sid)) throw new Error("Invalid session id.");
  if (!claims.ownerId || claims.ownerId.length > 80) throw new Error("Invalid owner.");
  const exp = claims.exp;
  const latest = Math.floor(nowMs / 1000) + OWNER_SESSION_TTL_SECONDS;
  if (!Number.isFinite(exp) || exp > latest || exp * 1000 <= nowMs) throw new Error("Invalid session expiry.");
  const payload = Buffer.from(JSON.stringify({ v: 2, sid: claims.sid, ownerId: claims.ownerId, exp }), "utf8").toString("base64url");
  return `${PREFIX}.${payload}.${signPayload(payload, expected)}`;
}

/** Returns null for a pre-fix cookie, a bad signature, a swapped owner, or an expired bound. */
export function verifyOwnerSession(token: string, secret: string, nowMs = Date.now()): OwnerSessionClaims | null {
  const expected = String(secret || "");
  if (!expected) return null;
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
  const digest = signPayload(parts[1], expected);
  const given = Buffer.from(parts[2]);
  const want = Buffer.from(digest);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Record<string, unknown>;
  const sid = String(row.sid || "");
  const ownerId = String(row.ownerId || "");
  const exp = Number(row.exp);
  if (row.v !== 2) return null;
  if (!/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
  if (!ownerId || ownerId.length > 80) return null;
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return null;
  if (exp > Math.floor(nowMs / 1000) + OWNER_SESSION_TTL_SECONDS) return null;
  return { sid, ownerId, exp };
}
