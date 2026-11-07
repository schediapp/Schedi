import { cookies } from "next/headers";
import { OWNER_SESSION_TTL_SECONDS, verifyOwnerSession } from "./owner-session";
import { getStore } from "./store";
import type { Owner } from "./types";

export const SESSION_COOKIE = "schedi_session";

export async function currentOwner(): Promise<Owner | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const parsed = verifyOwnerSession(token, process.env.SCHEDI_CONNECT_PAID_SECRET || "");
  if (!parsed) return null;
  const owner = getStore().getOwnerBySession(parsed.sid);
  if (!owner || owner.id !== parsed.ownerId) return null;
  return owner;
}

export function sessionCookieOptions(request: Request) {
  const forwarded = request.headers.get("x-forwarded-proto");
  const secure = forwarded
    ? forwarded.split(",")[0]?.trim() === "https"
    : new URL(request.url).protocol === "https:";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
    maxAge: OWNER_SESSION_TTL_SECONDS,
  };
}
