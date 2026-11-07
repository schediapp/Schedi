import { NextResponse } from "next/server";
import type { Store } from "./db";

/** Retryable freeze response. Stripe keeps retrying while the endpoint stays enabled. */
export function maintenanceResponse(): Response {
  return NextResponse.json(
    { ok: false, error: "maintenance" },
    { status: 503, headers: { "cache-control": "no-store", "retry-after": "30" } },
  );
}

export async function withWritable(store: Store, fn: () => Promise<Response>): Promise<Response> {
  if (!store.tryAdmit()) return maintenanceResponse();
  try {
    return await fn();
  } finally {
    store.releaseAdmit();
  }
}

/** A GET that refreshes Stripe into SQLite. Frozen hosts keep the stored row. */
export async function withReadRefresh<T>(store: Store, fallback: T, fn: () => Promise<T>): Promise<T> {
  if (!store.tryAdmit()) return fallback;
  try {
    return await fn();
  } finally {
    store.releaseAdmit();
  }
}
