import { cookies } from "next/headers";
import { SESSION_COOKIE, sessionCookieOptions } from "./session-cookie";
import { getStore } from "./store";
import type { Owner } from "./types";

export { SESSION_COOKIE, sessionCookieOptions };

export async function currentOwner(): Promise<Owner | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getStore().getOwnerBySession(token);
}
