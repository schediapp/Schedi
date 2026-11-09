export const SESSION_COOKIE = "schedi_session";

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

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    if (key !== name) continue;
    const raw = eq === -1 ? "" : trimmed.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function sessionSetCookie(request: Request, token: string): string {
  return serializeCookie(request, token, sessionCookieOptions(request).maxAge);
}

export function clearSessionCookie(request: Request): string {
  return serializeCookie(request, "", 0);
}

function serializeCookie(request: Request, token: string, maxAge: number): string {
  const options = sessionCookieOptions(request);
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}
