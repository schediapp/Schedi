import type { Store } from "./db";

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

export function diffSnapshotKeys(
  before: { tables: Record<string, Array<Record<string, unknown>>> },
  after: { tables: Record<string, Array<Record<string, unknown>>> },
  keys: Record<string, string>,
): Record<string, { added: number; removed: number; changed: number }> {
  const out: Record<string, { added: number; removed: number; changed: number }> = {};
  for (const [table, pk] of Object.entries(keys)) {
    const left = new Map((before.tables[table] || []).map((row) => [String(row[pk]), JSON.stringify(row)]));
    const right = new Map((after.tables[table] || []).map((row) => [String(row[pk]), JSON.stringify(row)]));
    let added = 0;
    let removed = 0;
    let changed = 0;
    for (const [id, value] of right) {
      if (!left.has(id)) added += 1;
      else if (left.get(id) !== value) changed += 1;
    }
    for (const id of left.keys()) if (!right.has(id)) removed += 1;
    out[table] = { added, removed, changed };
  }
  return out;
}
