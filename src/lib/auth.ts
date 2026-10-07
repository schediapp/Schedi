import { cookies } from "next/headers";
import { getStore } from "./store";
import type { Owner } from "./types";

export const SESSION_COOKIE = "schedi_session";

export async function currentOwner(): Promise<Owner | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getStore().getOwnerBySession(token);
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
    maxAge: 30 * 24 * 60 * 60,
  };
}
