import { NextResponse } from "next/server";
import { errorMessage, publicOrigin } from "./public-origin";

export { errorMessage, publicOrigin };

export function redirectTo(request: Request, path: string, params?: Record<string, string | undefined>) {
  const url = new URL(path, `${publicOrigin(request)}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, 303);
}
