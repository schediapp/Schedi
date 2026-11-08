import type { StripeEventDeps } from "./webhooks.ts";
import { applyStripeEvent, stripeEventRank } from "./webhooks.ts";
import type { Store } from "./db.ts";
export { diffSnapshotKeys } from "./snapshot-diff.ts";
import type Stripe from "stripe";

/** One Stripe event object from an Events API export. Not a signed webhook body. */
export interface ReconcileEvent {
  id: string;
  type: string;
  created?: number;
  account?: string | null;
  data?: { object?: Record<string, unknown> };
}

export interface ReconcilePlan {
  platform: { seen: number; alreadyDone: number; missing: string[] };
  connect: { seen: number; alreadyDone: number; missing: string[] };
  missingIds: string[];
  openCheckouts: Array<{ bookingId: string; sessionId: string | null; createdAt: string }>;
  duplicateIds: string[];
}

function scope(event: ReconcileEvent): "platform" | "connect" {
  return event.account ? "connect" : "platform";
}

/**
 * Compare an operator-supplied event export with events already marked done.
 * This does not call Stripe and does not write. Run it again after apply; it is idempotent.
 */
export function reconcileEvents(store: Store, events: ReconcileEvent[]): ReconcilePlan {
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  const platform = { seen: 0, alreadyDone: 0, missing: [] as string[] };
  const connect = { seen: 0, alreadyDone: 0, missing: [] as string[] };
  for (const event of events) {
    if (!event || typeof event.id !== "string" || typeof event.type !== "string") continue;
    if (seen.has(event.id)) {
      duplicateIds.push(event.id);
      continue;
    }
    seen.add(event.id);
    const bucket = scope(event) === "connect" ? connect : platform;
    bucket.seen += 1;
    if (store.hasStripeEvent(event.id)) bucket.alreadyDone += 1;
    else bucket.missing.push(event.id);
  }
  const openCheckouts: ReconcilePlan["openCheckouts"] = [];
  for (const business of store.listBusinesses()) {
    for (const booking of store.listBookings(business.id)) {
      if (booking.status !== "pending_payment") continue;
      openCheckouts.push({
        bookingId: booking.id,
        sessionId: booking.stripeCheckoutSessionId,
        createdAt: booking.createdAt,
      });
    }
  }
  return {
    platform,
    connect,
    missingIds: platform.missing.concat(connect.missing),
    openCheckouts,
    duplicateIds,
  };
}

/** Apply missing event ids. A second call is a no-op for ids already marked done. */
export async function applyMissingEvents(
  store: Store,
  events: ReconcileEvent[],
  deps?: StripeEventDeps,
): Promise<Array<{ id: string; status: string }>> {
  const missing = new Set(reconcileEvents(store, events).missingIds);
  const results: Array<{ id: string; status: string }> = [];
  const ordered = events.slice().sort((left, right) => {
    const created = Number(left.created || 0) - Number(right.created || 0);
    if (created !== 0) return created;
    const rank = stripeEventRank(left.type) - stripeEventRank(right.type);
    if (rank !== 0) return rank;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  for (const event of ordered) {
    if (!missing.has(event.id)) continue;
    try {
      await applyStripeEvent(store, event as unknown as Stripe.Event, deps);
      results.push({ id: event.id, status: store.hasStripeEvent(event.id) ? "done" : "skipped" });
    } catch (error) {
      results.push({ id: event.id, status: error instanceof Error ? error.message : "failed" });
    }
  }
  return results;
}

