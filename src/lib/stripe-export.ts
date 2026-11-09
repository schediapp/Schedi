import { chmodSync, writeFileSync } from "node:fs";
import type { ReconcileEvent } from "./reconcile";

export interface StripePage {
  data?: unknown[];
  has_more?: boolean;
  /** Stripe v2 list cursor. v1 event lists use has_more and starting_after instead. */
  next_page_url?: string | null;
}

/** A page list stopped before Stripe said it was finished. The export file is not written. */
export class IncompleteStripeExport extends Error {
  constructor(reason: "cursor_cycle" | "no_progress" | "page_budget") {
    super(
      reason === "cursor_cycle"
        ? "Stripe export stopped because a page cursor repeated."
        : reason === "no_progress"
          ? "Stripe export stopped because a page did not advance."
          : "Stripe export stopped because more pages remained at the page limit.",
    );
    this.name = "IncompleteStripeExport";
  }
}

/** Reads Stripe. The secret stays in the caller. This module never logs it. */
export interface StripeLister {
  get(path: string, accountId?: string): Promise<StripePage>;
}

function asEvent(value: unknown, accountId?: string): ReconcileEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { id?: unknown; type?: unknown; created?: unknown; account?: unknown; data?: { object?: Record<string, unknown> } };
  if (typeof row.id !== "string" || typeof row.type !== "string") return null;
  const account = typeof row.account === "string" ? row.account : accountId || null;
  return {
    id: row.id,
    type: row.type,
    created: typeof row.created === "number" ? row.created : undefined,
    account,
    data: row.data && typeof row.data === "object" ? { object: row.data.object || {} } : { object: {} },
  };
}

function asAccountId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.startsWith("acct_") ? id : null;
}

function v1PageUrl(path: string, startingAfter: string): string {
  const query = new URLSearchParams(path.includes("?") ? path.slice(path.indexOf("?") + 1) : "");
  query.set("limit", "100");
  if (startingAfter) query.set("starting_after", startingAfter);
  return `${path.split("?")[0]}?${query.toString()}`;
}

function normalizeCursor(value: string): string | null {
  if (value.startsWith("/v1/") || value.startsWith("/v2/")) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "api.stripe.com") return null;
    if (!url.pathname.startsWith("/v1/") && !url.pathname.startsWith("/v2/")) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

async function eachPage(
  lister: StripeLister,
  path: string,
  accountId: string | undefined,
  onRow: (row: unknown) => void,
  maxPages: number,
): Promise<void> {
  let startingAfter = "";
  let nextUrl = "";
  const seen = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const url = nextUrl || v1PageUrl(path, startingAfter);
    if (seen.has(url)) throw new IncompleteStripeExport("cursor_cycle");
    seen.add(url);
    const body = await lister.get(url, accountId);
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const row of rows) onRow(row);
    const next = body.next_page_url;
    if (typeof next === "string" && next) {
      const cursor = normalizeCursor(next);
      if (!cursor) throw new IncompleteStripeExport("no_progress");
      if (cursor === url || seen.has(cursor)) throw new IncompleteStripeExport("cursor_cycle");
      nextUrl = cursor;
      continue;
    }
    if (next != null && typeof next !== "string") throw new IncompleteStripeExport("no_progress");
    if (body.has_more === true) {
      if (rows.length === 0) throw new IncompleteStripeExport("no_progress");
      const last = rows[rows.length - 1] as { id?: unknown };
      if (typeof last?.id !== "string" || !last.id || last.id === startingAfter) {
        throw new IncompleteStripeExport("no_progress");
      }
      startingAfter = last.id;
      nextUrl = "";
      continue;
    }
    return;
  }
  throw new IncompleteStripeExport("page_budget");
}

/**
 * Platform events, then every connected account, then that account's events.
 * Connected events keep `account` so replay does not treat them as platform billing.
 */
export async function exportStripeMigrationSet(
  lister: StripeLister,
  createdGte?: number,
  options?: { maxPages?: number },
): Promise<{ platformEvents: ReconcileEvent[]; accountIds: string[]; connectEvents: ReconcileEvent[] }> {
  const maxPages = options?.maxPages ?? 1000;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new IncompleteStripeExport("page_budget");
  }
  const created = createdGte && Number.isFinite(createdGte) ? `&created[gte]=${Math.floor(createdGte)}` : "";
  const platformEvents: ReconcileEvent[] = [];
  const eventsPath = `/v1/events?${created.replace(/^&/, "")}`.replace(/\?$/, "");
  await eachPage(lister, eventsPath, undefined, (row) => {
    const event = asEvent(row);
    if (event && !event.account) platformEvents.push(event);
  }, maxPages);
  const accountIds: string[] = [];
  await eachPage(lister, "/v2/core/accounts", undefined, (row) => {
    const id = asAccountId(row);
    if (id && !accountIds.includes(id)) accountIds.push(id);
  }, maxPages);
  const connectEvents: ReconcileEvent[] = [];
  for (const accountId of accountIds) {
    await eachPage(lister, eventsPath, accountId, (row) => {
      const event = asEvent(row, accountId);
      if (event) connectEvents.push({ ...event, account: accountId });
    }, maxPages);
  }
  return { platformEvents, accountIds, connectEvents };
}

/** Writes the export only after every scope finished. A thrown list never reaches this. */
export function saveCompleteStripeExport(
  out: string,
  exported: { platformEvents: ReconcileEvent[]; accountIds: string[]; connectEvents: ReconcileEvent[] },
): void {
  const body = JSON.stringify({
    format: "schedi-stripe-export-v1",
    complete: true,
    platformEvents: exported.platformEvents,
    accountIds: exported.accountIds,
    connectEvents: exported.connectEvents,
  });
  writeFileSync(out, body, { mode: 0o600 });
  chmodSync(out, 0o600);
}

export async function exportAndSaveStripeMigrationSet(
  lister: StripeLister,
  out: string,
  createdGte?: number,
  options?: { maxPages?: number },
): Promise<{ platformEvents: ReconcileEvent[]; accountIds: string[]; connectEvents: ReconcileEvent[] }> {
  const exported = await exportStripeMigrationSet(lister, createdGte, options);
  saveCompleteStripeExport(out, exported);
  return exported;
}
