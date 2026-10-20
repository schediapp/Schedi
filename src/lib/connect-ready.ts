import { cardConnectStatus, type CardConnectStatus } from "./connect-status";

const READY_URL = process.env.SCHEDI_CONNECT_READY_URL || "https://schedi.app/billing/connect-ready";

/**
 * Tell the public booking tenant whether this connected account can take charges.
 * Callers that have an account publish in_progress until charges are enabled.
 * A missing account stays not_started and is not published from here.
 */
export async function publishStripeConnectReady(
  slug: string,
  ready: boolean,
  status?: CardConnectStatus,
): Promise<void> {
  const secret = process.env.SCHEDI_CONNECT_PAID_SECRET || "";
  const safeSlug = String(slug || "").trim().toLowerCase();
  if (!secret || !/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(safeSlug)) return;
  const resolved = ready === true ? "ready" : (status || cardConnectStatus(true, false));
  const response = await fetch(READY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-schedi-connect-secret": secret,
    },
    body: JSON.stringify({
      slug: safeSlug,
      ready: resolved === "ready",
      status: resolved,
    }),
  });
  if (!response.ok) {
    throw new Error("Could not publish stripeConnectReady.");
  }
}
