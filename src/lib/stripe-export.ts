import type { ReconcileEvent } from "./reconcile";

export interface StripePage {
  data?: unknown[];
  has_more?: boolean;
  /** Stripe v2 list cursor. v1 event lists use has_more and starting_after instead. */
  next_page_url?: string | null;
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

async function eachPage(lister: StripeLister, path: string, accountId: string | undefined, onRow: (row: unknown) => void): Promise<void> {
  let startingAfter = "";
  let nextUrl = "";
  const seen = new Set<string>();
  for (let page = 0; page < 1000; page += 1) {
    const url = nextUrl || v1PageUrl(path, startingAfter);
    if (seen.has(url)) return;
    seen.add(url);
    const body = await lister.get(url, accountId);
    const rows = Array.isArray(body.data) ? body.data : [];
    for (const row of rows) onRow(row);
    if (typeof body.next_page_url === "string" && body.next_page_url && body.next_page_url !== url) {
      nextUrl = body.next_page_url;
      continue;
    }
    if (body.next_page_url === null || !body.has_more || rows.length === 0) return;
    const last = rows[rows.length - 1] as { id?: unknown };
    if (typeof last?.id !== "string" || last.id === startingAfter) return;
    startingAfter = last.id;
    nextUrl = "";
  }
}

/**
 * Platform events, then every connected account, then that account's events.
 * Connected events keep `account` so replay does not treat them as platform billing.
 */
export async function exportStripeMigrationSet(
  lister: StripeLister,
  createdGte?: number,
): Promise<{ platformEvents: ReconcileEvent[]; accountIds: string[]; connectEvents: ReconcileEvent[] }> {
  const created = createdGte && Number.isFinite(createdGte) ? `&created[gte]=${Math.floor(createdGte)}` : "";
  const platformEvents: ReconcileEvent[] = [];
  await eachPage(lister, `/v1/events?${created.replace(/^&/, "")}`.replace(/\?$/, ""), undefined, (row) => {
    const event = asEvent(row);
    if (event && !event.account) platformEvents.push(event);
  });
  const accountIds: string[] = [];
  await eachPage(lister, "/v2/core/accounts", undefined, (row) => {
    const id = asAccountId(row);
    if (id && !accountIds.includes(id)) accountIds.push(id);
  });
  const connectEvents: ReconcileEvent[] = [];
  for (const accountId of accountIds) {
    await eachPage(lister, `/v1/events?${created.replace(/^&/, "")}`.replace(/\?$/, ""), accountId, (row) => {
      const event = asEvent(row, accountId);
      if (event) connectEvents.push({ ...event, account: accountId });
    });
  }
  return { platformEvents, accountIds, connectEvents };
}
