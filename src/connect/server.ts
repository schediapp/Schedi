import { backfillStripeConnectReady, connectAdminAuthorized } from "../lib/connect-backfill";
import { placeBooking } from "../lib/bookings";
import { cancelOwnerSubscription, resumeOwnerSubscription, startOwnerSubscription } from "../lib/billing";
import { acceptConnectHandoff } from "../lib/connect-handoff";
import { createEmbeddedAccountSession, enableCardPayments, forceParkMissingConnectedAccount } from "../lib/connect";
import { contentSecurityPolicy } from "../lib/csp";
import type { Store } from "../lib/db";
import { SchediError } from "../lib/errors";
import { errorMessage, publicOrigin } from "../lib/public-origin";
import { parsePaymentChoice } from "../lib/payment-options";
import { fetchSchediPlan } from "../lib/plan-entitlement";
import { createConnectPaymentLink, publicReturnOrigin } from "../lib/public-card-checkout";
import { clearSessionCookie, readCookie, SESSION_COOKIE, sessionSetCookie } from "../lib/session-cookie";
import type { ConnectSnapshot } from "../lib/snapshot";
import { parseSnapshot } from "../lib/snapshot";
import { createStripeClient } from "../lib/stripe";
import { formatConnectEnableError } from "../lib/stripe-error";
import { connectConfigFrom, connectConfigFromProcess, type ConnectConfig } from "../lib/connect-config";
import { constructVerifiedEventAsync } from "../lib/webhook-signature";
import { applyStripeEvent } from "../lib/webhooks";
import type Stripe from "stripe";
import { dashboardScript, renderBooked, renderBooking, renderHandoff, renderHome, renderPortal } from "./pages";
import { applyMissingEvents, reconcileEvents, type ReconcileEvent } from "../lib/reconcile";

const CHECKOUT_ORIGINS = new Set(["https://schedi.app", "https://www.schedi.app"]);

export interface ConnectRuntime {
  store: Store;
  /** Immutable settings for this request. Preferred. */
  config?: ConnectConfig;
  /** Read once into config. Never written back to process.env. */
  env?: Record<string, string | undefined>;
  stripe?: Stripe | null;
}

export async function handleConnectRequest(request: Request, runtime: ConnectRuntime): Promise<Response> {
  const config = runtime.config ?? (runtime.env ? connectConfigFrom(runtime.env) : connectConfigFromProcess());
  return dispatch(request, { ...runtime, config });
}

function stripeClient(runtime: ConnectRuntime & { config: ConnectConfig }): Stripe | null {
  if (runtime.stripe !== undefined) return runtime.stripe;
  return runtime.config.stripeSecretKey ? createStripeClient(runtime.config.stripeSecretKey) : null;
}

function requireStripe(runtime: ConnectRuntime & { config: ConnectConfig }): Stripe {
  const stripe = stripeClient(runtime);
  if (!stripe) throw new SchediError("STRIPE_SECRET_KEY is not set.", 500);
  return stripe;
}

async function dispatch(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  const { store } = runtime;
  try {
    if (request.method === "GET" && path === "/connect-dashboard.js") {
      return new Response(dashboardScript(), {
        status: 200,
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (request.method === "GET" && path === "/") return html(renderHome(store));
    if (request.method === "GET" && path === "/portal") {
      return html(await renderPortal(store, request, stripeClient(runtime), url.searchParams, runtime.config));
    }
    if (request.method === "GET" && path === "/api/health") return health(runtime);
    if (request.method === "POST" && path === "/api/health") return delayedHealth(runtime);
    if (request.method === "GET" && path === "/api/connect/handoff") return handoffPage();
    if (request.method === "POST" && path === "/api/connect/handoff") return withWriters(store, () => postHandoff(request, runtime));
    if (request.method === "POST" && path === "/api/session") return withWriters(store, () => postSession(request, store, runtime.config));
    if (request.method === "POST" && path === "/api/billing") return withWriters(store, () => postBilling(request, runtime));
    if (request.method === "POST" && path === "/api/business") return withWriters(store, () => postBusiness(request, store));
    if (request.method === "POST" && path === "/api/bookings") return withWriters(store, () => postBooking(request, runtime));
    if (request.method === "POST" && path === "/api/connect/enable") return withWriters(store, () => postEnable(request, runtime));
    if (request.method === "POST" && path === "/api/connect/session") return withWriters(store, () => postConnectSession(request, runtime));
    if (path === "/api/public-checkout" && request.method === "OPTIONS") return publicCheckout(request, runtime);
    if (path === "/api/public-checkout" && request.method === "POST") {
      return withWriters(store, () => publicCheckout(request, runtime));
    }
    if (request.method === "POST" && path === "/api/webhooks/stripe") return postWebhook(request, runtime);
    if (request.method === "GET" && path === "/api/admin/sqlite-snapshot") return adminSnapshot(request, runtime);
    if (request.method === "POST" && path === "/api/admin/sqlite-restore") return adminRestore(request, runtime);
    if (request.method === "POST" && path === "/api/admin/maintenance") return adminMaintenance(request, runtime);
    if (request.method === "POST" && path === "/api/admin/reconcile") return adminReconcile(request, runtime);
    if (request.method === "POST" && path === "/api/admin/release-processing") return adminReleaseProcessing(request, runtime);
    if (request.method === "POST" && path === "/api/admin/connect-ready-backfill") {
      return withWriters(store, () => adminBackfill(request, runtime));
    }
    if (request.method === "POST" && path === "/api/admin/force-park-missing-account") {
      return withWriters(store, () => adminForcePark(request, runtime));
    }
    const booking = path.match(/^\/b\/([^/]+)$/);
    if (request.method === "GET" && booking) {
      return html(await renderBooking(store, stripeClient(runtime), decodeURIComponent(booking[1]), url.searchParams, runtime.config));
    }
    const booked = path.match(/^\/b\/([^/]+)\/booked$/);
    if (request.method === "GET" && booked) {
      return html(
        await renderBooked(
          store,
          stripeClient(runtime),
          decodeURIComponent(booked[1]),
          url.searchParams.get("booking") || "",
          runtime.config,
        ),
      );
    }
    if (path.startsWith("/api/")) return json({ error: "Not found.", path, method: request.method }, 404);
    return html("<main class=\"shell\"><h1>That page is not here.</h1></main>", 404);
  } catch (error) {
    const status = error instanceof SchediError ? error.status : 500;
    if (path.startsWith("/api/")) return json({ ok: false, error: errorMessage(error) }, status);
    return redirect(request, "/portal", { error: errorMessage(error) });
  }
}

function html(body: string, status = 200): Response {
  const document = body.startsWith("<!DOCTYPE") ? body : `<!DOCTYPE html><html lang="en"><body>${body}</body></html>`;
  return new Response(document, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy(),
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-content-type-options": "nosniff",
    },
  });
}

function handoffPage(): Response {
  return new Response(renderHandoff(), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "x-content-type-options": "nosniff",
    },
  });
}

function json(body: unknown, status: number, extra?: Headers): Response {
  const headers = extra ?? new Headers();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function redirect(
  request: Request,
  path: string,
  params?: Record<string, string | undefined>,
  setCookie?: string,
  config?: ConnectConfig,
): Response {
  const url = new URL(path, `${publicOrigin(request, config)}/`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) url.searchParams.set(key, value);
  }
  const headers = new Headers({ location: url.toString(), "cache-control": "no-store" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(null, { status: 303, headers });
}

function currentOwner(store: Store, request: Request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  return store.getOwnerBySession(token);
}

function migrationAuthorized(request: Request, config: ConnectConfig): boolean {
  return connectAdminAuthorized(request.headers.get("x-schedi-migration-secret"), config.migrationSecret);
}

function maintenanceBody(): Response {
  return json({ ok: false, error: "maintenance" }, 503, new Headers({ "retry-after": "30" }));
}

async function withWriters(
  store: Store,
  fn: () => Promise<Response>,
): Promise<Response> {
  if (!store.tryAdmit()) return maintenanceBody();
  try {
    return await fn();
  } finally {
    store.releaseAdmit();
  }
}

function health(runtime: ConnectRuntime & { config: ConnectConfig }): Response {
  const state = runtime.store.maintenance();
  return json({
    ok: true,
    service: "schedi-connect-migration",
    frozen: state.frozen,
    admitted: state.admitted,
    emailSignIn: runtime.config.emailSignIn,
    paidCallbackHost: hostOf(runtime.config.connectPaidUrl),
    readyCallbackHost: hostOf(runtime.config.connectReadyUrl),
    planCallbackHost: hostOf(runtime.config.planUrl),
  }, 200);
}

async function delayedHealth(runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  if (runtime.config.testDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, runtime.config.testDelayMs));
  return health(runtime);
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

async function postSession(request: Request, store: Store, config: ConnectConfig): Promise<Response> {
  const form = await request.formData();
  const intent = String(form.get("intent") || "sign-in");
  if (intent !== "sign-out") {
    return redirect(request, "/portal", {
      error: "Use Set up Stripe in Schedi. An email address alone does not open this portal.",
    }, undefined, config);
  }
  const token = readCookie(request, SESSION_COOKIE);
  if (token) store.deleteSession(token);
  return redirect(request, "/portal", undefined, clearSessionCookie(request), config);
}

async function postBilling(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const owner = currentOwner(runtime.store, request);
  if (!owner) return redirect(request, "/portal", { error: "Sign in required." });
  const form = await request.formData();
  const plan = String(form.get("plan") || "");
  const origin = publicOrigin(request, runtime.config);
  try {
    const stripe = requireStripe(runtime);
    if (plan === "cancel") {
      await cancelOwnerSubscription(runtime.store, stripe, owner.id);
      return redirect(request, "/portal", { updated: "1" });
    }
    if (plan === "resume") {
      await resumeOwnerSubscription(runtime.store, stripe, owner.id);
      return redirect(request, "/portal", { updated: "1" });
    }
    if (plan !== "starter" && plan !== "pro") return redirect(request, "/portal", { error: "Choose Starter or Pro." });
    const result = await startOwnerSubscription(runtime.store, stripe, owner.id, plan, {
      success: `${origin}/portal?session_id={CHECKOUT_SESSION_ID}`,
      cancel: `${origin}/portal`,
    }, { starter: runtime.config?.priceStarter || "", pro: runtime.config?.pricePro || "" });
    if (result.kind === "updated") return redirect(request, "/portal", { updated: "1" });
    return redirect(request, result.url);
  } catch (error) {
    return redirect(request, "/portal", { error: errorMessage(error) });
  }
}

async function postBusiness(request: Request, store: Store): Promise<Response> {
  const owner = currentOwner(store, request);
  if (!owner) return redirect(request, "/portal", { error: "Sign in required." });
  const form = await request.formData();
  const business = store.getBusinessByOwner(owner.id);
  if (!business) return redirect(request, "/portal", { error: "Business not found." });
  try {
    const depositEnabled = form.get("deposit_enabled") === "on";
    const rawAmount = String(form.get("deposit_amount") || "").trim();
    let depositAmountCents: number | null = null;
    if (rawAmount) {
      const dollars = Number(rawAmount);
      if (!Number.isFinite(dollars) || dollars < 0.5) throw new SchediError("A deposit is at least $0.50.", 400);
      depositAmountCents = Math.round(dollars * 100);
    }
    if (depositEnabled && depositAmountCents == null) throw new SchediError("Enter a deposit amount.", 400);
    store.updatePaymentSettings(business.id, {
      cashApp: String(form.get("cash_app") || ""),
      zelle: String(form.get("zelle") || ""),
      venmo: String(form.get("venmo") || ""),
      paypal: String(form.get("paypal") || ""),
      payAtAppointment: form.get("pay_at_appointment") === "on",
      depositEnabled,
      depositAmountCents,
    });
    return redirect(request, "/portal");
  } catch (error) {
    return redirect(request, "/portal", { error: errorMessage(error) });
  }
}

async function postBooking(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const form = await request.formData();
  const slug = String(form.get("slug") || "");
  const payment = parsePaymentChoice(String(form.get("payment") || ""));
  const origin = publicOrigin(request, runtime.config);
  if (!payment) return redirect(request, `/b/${slug}`, { error: "Choose how you'll pay." });
  try {
  const { booking, redirectUrl } = await placeBooking(runtime.store, stripeClient(runtime), {
    slug,
    serviceId: String(form.get("service_id") || ""),
    startsAt: String(form.get("starts_at") || ""),
    clientName: String(form.get("client_name") || ""),
    clientEmail: String(form.get("client_email") || ""),
    method: payment.method,
    chargeKind: payment.chargeKind,
    successUrl: `${origin}/b/${slug}/booked?booking={BOOKING_ID}&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/b/${slug}?canceled=1`,
  });
  if (redirectUrl) return redirect(request, redirectUrl);
  return redirect(request, `/b/${slug}/booked`, { booking: booking.id });
  } catch (error) {
    return redirect(request, `/b/${slug || ""}`, { error: errorMessage(error) });
  }
}

async function postEnable(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const owner = currentOwner(runtime.store, request);
  if (!owner) return redirect(request, "/portal", { error: "Sign in required." });
  try {
    await enableCardPayments(runtime.store, requireStripe(runtime), owner.id);
    return redirect(request, "/portal#stripe-setup");
  } catch (error) {
    const failure = formatConnectEnableError(error);
    if (failure.log) {
      console.error(
        "Card payments could not be turned on:",
        JSON.stringify({ type: failure.log.type, message: failure.log.message, code: failure.log.code }),
      );
    } else {
      console.error("Card payments could not be turned on:", failure.message);
    }
    return redirect(request, "/portal", { error: failure.message, code: failure.code, source: "connect" });
  }
}

async function postConnectSession(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const owner = currentOwner(runtime.store, request);
  if (!owner) return json({ error: "Sign in required." }, 401);
  const business = runtime.store.getBusinessByOwner(owner.id);
  if (!business?.stripeAccountId) return json({ error: "Turn on card payments before onboarding." }, 409);
  try {
    const session = await createEmbeddedAccountSession(requireStripe(runtime), business.stripeAccountId);
    return json({ clientSecret: session.client_secret }, 200);
  } catch (error) {
    return json({ error: errorMessage(error) }, 502);
  }
}

async function postHandoff(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const form = await request.formData();
  const token = String(form.get("t") || "");
  const accepted = await acceptConnectHandoff(
    runtime.store,
    token,
    runtime.config?.connectPaidSecret || "",
    (query) => fetchSchediPlan(query, runtime.config),
  );
  if (!accepted.ok) return redirect(request, "/portal", { error: accepted.error });
  const session = runtime.store.createSession(accepted.ownerId);
  let destination = redirect(request, "/portal#stripe-setup", undefined, sessionSetCookie(request, session));
  try {
    await enableCardPayments(runtime.store, requireStripe(runtime), accepted.ownerId);
  } catch (error) {
    destination = redirect(
      request,
      "/portal",
      { error: errorMessage(error), source: "connect" },
      sessionSetCookie(request, session),
    );
  }
  return destination;
}

function checkoutCors(request: Request): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "Content-Type",
    "cache-control": "no-store",
  });
  const origin = request.headers.get("origin") || "";
  if (CHECKOUT_ORIGINS.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return headers;
}

async function publicCheckout(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const headers = checkoutCors(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  let payload: Record<string, unknown> = {};
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, headers);
  }
  const slug = String(payload.slug || payload.tenantId || "").trim().toLowerCase();
  const tenantId = String(payload.tenantId || slug).trim();
  const bookingIds = (Array.isArray(payload.bookingIds) ? payload.bookingIds : [payload.bookingId])
    .map((id) => String(id || "").trim())
    .filter((id) => /^[A-Za-z0-9_-]{4,40}$/.test(id));
  const email = String(payload.email || "").trim().toLowerCase();
  const serviceName = String(payload.serviceName || "Appointment").trim().slice(0, 120) || "Appointment";
  const amountCents = Math.round(Number(payload.amountCents));
  const chargeKind = payload.chargeKind === "full" ? "full" : payload.chargeKind === "deposit" ? "deposit" : "";
  const returnOrigin = String(payload.returnOrigin || "https://schedi.app");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,40})$/.test(slug)) return json({ ok: false, error: "invalid_tenant" }, 400, headers);
  if (!bookingIds.length) return json({ ok: false, error: "invalid_booking" }, 400, headers);
  if (!Number.isInteger(amountCents) || amountCents < 50 || amountCents > 1_000_000) {
    return json({ ok: false, error: "amount_too_small" }, 400, headers);
  }
  if (!chargeKind) return json({ ok: false, error: "invalid_charge" }, 400, headers);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ ok: false, error: "invalid_email" }, 400, headers);
  let origin: string;
  try {
    origin = publicReturnOrigin(returnOrigin);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, error instanceof SchediError ? error.status : 400, headers);
  }
  const stripe = stripeClient(runtime);
  if (!stripe) return json({ ok: false, error: "connect_unavailable" }, 409, headers);
  const business = runtime.store.getBusinessBySlug(slug);
  try {
    const created = await createConnectPaymentLink(stripe, business, {
      slug,
      tenantId,
      bookingIds,
      email,
      serviceName,
      amountCents,
      chargeKind,
      returnOrigin: origin,
    });
    if (!created) return json({ ok: false, error: "connect_unavailable" }, 409, headers);
    return json(
      { ok: true, url: created.url, paymentLink: created.url, durableUrl: created.durableUrl, mode: "connect" },
      200,
      headers,
    );
  } catch (error) {
    const status = error instanceof SchediError ? error.status : 502;
    return json({ ok: false, error: errorMessage(error) }, status, headers);
  }
}

async function postWebhook(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return json({ error: "Missing Stripe signature." }, 400);
  const payload = await request.text();
  const stripe = runtime.stripe ?? createStripeClient(runtime.config.stripeSecretKey || "sk_test_signature_only");
  let event: Stripe.Event;
  try {
    event = await constructVerifiedEventAsync(stripe, payload, signature, {
      STRIPE_WEBHOOK_SECRET: runtime.config.platformWebhookSecret,
      STRIPE_CONNECT_WEBHOOK_SECRET: runtime.config.connectWebhookSecret,
    } as unknown as NodeJS.ProcessEnv);
  } catch (error) {
    const status = error instanceof SchediError ? error.status : 400;
    return json({ error: errorMessage(error) }, status);
  }
  if (!runtime.store.tryAdmit()) return maintenanceBody();
  try {
    await applyStripeEvent(runtime.store, event, { config: runtime.config });
    return json({ received: true }, 200);
  } catch (error) {
    const status = error instanceof SchediError ? error.status : 500;
    return json({ error: errorMessage(error) }, status);
  } finally {
    runtime.store.releaseAdmit();
  }
}

function adminSnapshot(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Response {
  if (!migrationAuthorized(request, runtime.config)) return json({ ok: false, error: "unauthorized" }, 401);
  const state = runtime.store.maintenance();
  if (!state.frozen) return json({ ok: false, error: "freeze_required" }, 409);
  if (state.admitted !== 0) return json({ ok: false, error: "drain_in_progress", admitted: state.admitted }, 409);
  const parity = runtime.store.pragmaStatus();
  const snapshot = runtime.store.consistentSnapshot();
  const body = JSON.stringify(snapshot);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": 'attachment; filename="schedi-connect-snapshot.json"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-schedi-integrity": parity.integrity,
      "x-schedi-foreign-keys": String(parity.foreignKeyViolations),
    },
  });
}

async function adminRestore(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  if (!migrationAuthorized(request, runtime.config)) return json({ ok: false, error: "unauthorized" }, 401);
  const store = runtime.store;
  const confirm = request.headers.get("x-schedi-restore-confirm") || "dry-run";
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON body." }, 400);
  }
  let snapshot: ConnectSnapshot;
  try {
    snapshot = parseSnapshot(payload);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, error instanceof SchediError ? error.status : 400);
  }
  if (confirm !== "restore-empty-database") {
    const report = store.restoreConsistentSnapshot(snapshot, "dry-run");
    return json({ ...report, mode: "dry-run" }, report.ok ? 200 : 409);
  }
  const state = store.maintenance();
  if (!state.frozen || state.admitted !== 0) return json({ ok: false, error: "freeze_required" }, 409);
  try {
    const report = store.restoreConsistentSnapshot(snapshot, "empty-only");
    const pragma = store.pragmaStatus();
    const pragmaOk = (pragma.integrity === "ok" && pragma.foreignKeyViolations === 0) || pragma.integrity === "unsupported";
    const status = report.applied && report.checksum === snapshot.checksum && pragmaOk ? 200 : 500;
    return json({ ...report, mode: "empty-only", pragma }, status);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, error instanceof SchediError ? error.status : 500);
  }
}

async function adminMaintenance(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  if (!migrationAuthorized(request, runtime.config)) return json({ ok: false, error: "unauthorized" }, 401);
  let body: { mode?: string } = {};
  try {
    body = (await request.json()) as { mode?: string };
  } catch {
    return json({ ok: false, error: "Expected a JSON body." }, 400);
  }
  if (body.mode === "frozen") return json({ ok: true, ...runtime.store.freezeWriters() }, 200);
  if (body.mode === "open") {
    if (request.headers.get("x-schedi-maintenance-confirm") !== "open-writers") {
      return json({ ok: false, error: "confirm_open_writers" }, 409);
    }
    return json({ ok: true, ...runtime.store.openWriters() }, 200);
  }
  return json({ ok: false, error: "Expected mode frozen or open." }, 400);
}

async function adminReleaseProcessing(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  if (!migrationAuthorized(request, runtime.config)) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    const released = runtime.store.releaseProcessingClaims();
    return json({ ok: true, released }, 200);
  } catch (error) {
    return json({ ok: false, error: errorMessage(error) }, error instanceof SchediError ? error.status : 409);
  }
}

async function adminReconcile(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  if (!migrationAuthorized(request, runtime.config)) return json({ ok: false, error: "unauthorized" }, 401);
  let payload: { events?: ReconcileEvent[]; apply?: boolean } = {};
  try {
    payload = (await request.json()) as { events?: ReconcileEvent[]; apply?: boolean };
  } catch {
    return json({ ok: false, error: "Expected a JSON body." }, 400);
  }
  const events = Array.isArray(payload.events) ? payload.events : [];
  const plan = reconcileEvents(runtime.store, events);
  if (payload.apply !== true) return json({ ok: true, applied: false, ...plan }, 200);
  const state = runtime.store.maintenance();
  if (!state.frozen || state.admitted !== 0) {
    return json({ ok: false, error: "freeze_required", ...plan }, 409);
  }
  const results = await applyMissingEvents(runtime.store, events, { config: runtime.config });
  return json({ ok: true, applied: true, ...plan, results }, 200);
}

async function adminBackfill(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  if (!migrationAuthorized(request, runtime.config)) return json({ ok: false, error: "unauthorized" }, 401);
  const result = await backfillStripeConnectReady(runtime.store, requireStripe(runtime));
  return json({ ok: true, ...result }, 200);
}

async function adminForcePark(request: Request, runtime: ConnectRuntime & { config: ConnectConfig }): Promise<Response> {
  if (!migrationAuthorized(request, runtime.config)) return json({ ok: false, error: "unauthorized" }, 401);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "Expected a JSON body." }, 400);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return json({ ok: false, error: "Expected a JSON object." }, 400);
  }
  const body = payload as { slug?: unknown; businessId?: unknown };
  const result = await forceParkMissingConnectedAccount(runtime.store, requireStripe(runtime), {
    slug: typeof body.slug === "string" ? body.slug : null,
    businessId: typeof body.businessId === "string" ? body.businessId : null,
  });
  return json(result, 200);
}

export async function handleAdminSnapshot(request: Request, store: Store, secret: string | undefined): Promise<Response> {
  const config = connectConfigFrom({ SCHEDI_MIGRATION_SECRET: secret || "" });
  return adminSnapshot(request, { store, config });
}
