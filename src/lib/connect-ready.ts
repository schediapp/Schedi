import type { ConnectConfig } from "./connect-config";
import { connectConfigFromProcess } from "./connect-config.ts";
import { cardConnectStatus, type CardConnectStatus } from "./connect-status.ts";

export interface ConnectReadyNotice {
  slug: string;
  ready: boolean;
  status: CardConnectStatus;
  eventId: string;
  observedAt: string;
}

/**
 * Tell the public booking tenant whether this connected account can take charges.
 * The URL and secret come from the request config when the caller has one.
 * observedAt lets the receiver ignore an older account update.
 */
export async function publishStripeConnectReady(
  slug: string,
  ready: boolean,
  status?: CardConnectStatus,
  notice?: { eventId?: string; observedAt?: string },
  config?: ConnectConfig,
): Promise<void> {
  const resolvedConfig = config ?? connectConfigFromProcess();
  const secret = resolvedConfig.connectPaidSecret;
  const safeSlug = String(slug || "").trim().toLowerCase();
  if (!secret || !/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(safeSlug)) return;
  const resolved = ready === true ? "ready" : (status || cardConnectStatus(true, false));
  const body: Record<string, unknown> = {
    slug: safeSlug,
    ready: resolved === "ready",
    status: resolved,
  };
  if (notice?.eventId) body.eventId = notice.eventId;
  if (notice?.observedAt) body.observedAt = notice.observedAt;
  const response = await fetch(resolvedConfig.connectReadyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-schedi-connect-secret": secret,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("Could not publish stripeConnectReady.");
  }
}
