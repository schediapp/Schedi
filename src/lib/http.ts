import { NextResponse } from "next/server";
import { SchediError } from "./errors";

export function errorMessage(error: unknown): string {
  if (error instanceof SchediError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

export function redirectTo(request: Request, path: string, params?: Record<string, string | undefined>) {
  const url = new URL(path, request.url);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url, 303);
}
