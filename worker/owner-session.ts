// Owner sessions live in the same AUTH_KV records the email worker writes.
// A password reset stores sessrevoke:{tenantId}; sessions created before that are dead.

import type { AgencyKv } from "./public-shell";

export interface OwnerSession {
  role?: string;
  tenantId?: string;
  email?: string;
  exp?: number;
  /** Set only for a stored owner session whose exp has passed. Other readers treat that as signed out. */
  expired?: boolean;
}

/** Session for a logo write. An expired owner session is returned with expired: true so the page can ask them to sign in. */
export async function readLogoWriteSession(kv: AgencyKv | undefined, token: string): Promise<OwnerSession | null> {
  const value = String(token || "").trim();
  if (!kv || !value) return null;
  let raw: string | null = null;
  try {
    raw = await kv.get("session:" + value);
  } catch {
    return null;
  }
  if (!raw) return null;
  let session: OwnerSession;
  try {
    session = JSON.parse(raw) as OwnerSession;
  } catch {
    return null;
  }
  if (!session) return null;
  if (Number(session.exp || 0) < Date.now()) {
    if (session.role === "owner") return { role: "owner", tenantId: session.tenantId, expired: true };
    return null;
  }
  if (session.role === "owner" && session.tenantId) {
    let notBefore = 0;
    try {
      notBefore = Number((await kv.get("sessrevoke:" + session.tenantId)) || 0);
    } catch {
      notBefore = 0;
    }
    const createdAt = Number(session.exp || 0) - 12 * 60 * 60 * 1000;
    if (notBefore && createdAt < notBefore) return null;
  }
  return session;
}

export async function readOwnerSession(kv: AgencyKv | undefined, token: string): Promise<OwnerSession | null> {
  const session = await readLogoWriteSession(kv, token);
  if (!session || session.expired) return null;
  return session;
}
