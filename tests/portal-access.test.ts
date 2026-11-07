import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acceptConnectHandoff } from "../src/lib/connect-handoff";
import { enableCardPayments } from "../src/lib/connect";
import { isCardPlanPro, parseSchediPlan } from "../src/lib/plan-entitlement";
import { OWNER_SESSION_TTL_SECONDS, signOwnerSession, verifyOwnerSession } from "../src/lib/owner-session";
import { createFakeStripe, memoryStore, seedProBusiness } from "./helpers";
// @ts-expect-error plain JS module
import { connectPlanView, connectPortalPage, signConnectHandoff } from "../workers/schedi-email-worker/src/connect-handoff.js";

const SECRET = "portal-access-secret";

function remote(plan: "free" | "starter" | "pro", status: string, extra: Record<string, unknown> = {}) {
  return parseSchediPlan({
    ok: true,
    ...connectPlanView({
      id: "northwind",
      slug: "northwind",
      name: "Northwind",
      ownerEmail: "owner@example.com",
      ownerName: "Ada",
      plan,
      subscriptionStatus: status,
      ...extra,
    }),
  });
}

async function openPortal(plan: "free" | "starter" | "pro", status: string, extra: Record<string, unknown> = {}) {
  const store = memoryStore();
  const now = Date.parse("2026-11-07T00:00:00Z");
  const nonce = `nonce-${plan}-${status}`.replace(/[^A-Za-z0-9_-]/g, "").padEnd(16, "x");
  const token = await signConnectHandoff({
    v: 1,
    slug: "northwind",
    email: "owner@example.com",
    ownerName: "Ada",
    businessName: "Northwind",
    nonce,
    exp: Math.floor(now / 1000) + 90,
  }, SECRET);
  const looked = remote(plan, status, extra);
  const opened = await acceptConnectHandoff(store, token, SECRET, async () => looked, now);
  return { store, opened, looked };
}

describe("verified portal access by plan", () => {
  it("opens Free, Starter, Pro, and complimentary without granting card setup to a lower plan", async () => {
    const free = await openPortal("free", "none");
    expect(free.opened.ok).toBe(true);
    if (!free.opened.ok) return;
    expect(free.opened.business.plan).toBe("free");
    expect(isCardPlanPro(free.opened.business)).toBe(false);
    const stripe = createFakeStripe();
    await expect(enableCardPayments(free.store, stripe, free.opened.ownerId)).rejects.toThrow(/active Pro/);
    expect(stripe.calls).toEqual([]);

    const starter = await openPortal("starter", "active");
    expect(starter.opened.ok).toBe(true);
    if (!starter.opened.ok) return;
    expect(starter.opened.business.plan).toBe("starter");
    expect(isCardPlanPro(starter.opened.business)).toBe(false);

    const pro = await openPortal("pro", "active");
    expect(pro.opened.ok).toBe(true);
    if (!pro.opened.ok) return;
    expect(pro.opened.business.plan).toBe("pro");
    expect(isCardPlanPro(pro.opened.business)).toBe(true);

    const comp = await openPortal("free", "none", { complimentaryPro: true });
    expect(comp.opened.ok).toBe(true);
    if (!comp.opened.ok) return;
    expect(comp.opened.business.plan).toBe("pro");
    expect(comp.opened.business.complimentaryPro).toBe(true);
    expect(isCardPlanPro(comp.opened.business)).toBe(true);

    const paused = await openPortal("pro", "past_due");
    expect(paused.opened.ok).toBe(true);
    if (!paused.opened.ok) return;
    expect(paused.opened.business.plan).toBe("pro");
    expect(paused.opened.business.subscriptionStatus).toBe("past_due");
    expect(isCardPlanPro(paused.opened.business)).toBe(false);
  });

  it("fails closed for the wrong owner, a slug mismatch, a replay, and a tampered link", async () => {
    const store = memoryStore();
    const { business } = seedProBusiness(store, {
      email: "owner@example.com",
      slug: "northwind",
      plan: "starter",
      subscriptionStatus: "active",
      stripeSubscriptionId: "sub_keep",
    });
    const now = Date.parse("2026-11-07T00:00:00Z");
    const token = await signConnectHandoff({
      v: 1,
      slug: "northwind",
      email: "owner@example.com",
      ownerName: "Ada",
      businessName: "Northwind",
      nonce: "nonce-wrong-owner-01",
      exp: Math.floor(now / 1000) + 90,
    }, SECRET);
    const wrong = await acceptConnectHandoff(store, token, SECRET, async () => parseSchediPlan({
      ok: true,
      slug: "northwind",
      name: "Northwind",
      ownerEmail: "other@example.com",
      plan: "pro",
      subscriptionStatus: "active",
      cardEntitled: true,
    }), now);
    expect(wrong.ok).toBe(false);
    expect(store.getBusiness(business.id).plan).toBe("starter");
    expect(store.getBusiness(business.id).stripeSubscriptionId).toBe("sub_keep");

    const mismatch = await signConnectHandoff({
      v: 1,
      slug: "northwind",
      email: "owner@example.com",
      ownerName: "Ada",
      businessName: "Northwind",
      nonce: "nonce-slug-mismatch1",
      exp: Math.floor(now / 1000) + 90,
    }, SECRET);
    const slipped = await acceptConnectHandoff(store, mismatch, SECRET, async () => parseSchediPlan({
      ok: true,
      slug: "other-shop",
      ownerEmail: "owner@example.com",
      plan: "pro",
      subscriptionStatus: "active",
      cardEntitled: true,
    }), now);
    expect(slipped.ok).toBe(false);
    expect(store.getBusiness(business.id).slug).toBe("northwind");

    const replay = await signConnectHandoff({
      v: 1,
      slug: "northwind",
      email: "owner@example.com",
      ownerName: "Ada",
      businessName: "Northwind",
      nonce: "nonce-replay-portal1",
      exp: Math.floor(now / 1000) + 90,
    }, SECRET);
    const looked = remote("starter", "active");
    expect((await acceptConnectHandoff(store, replay, SECRET, async () => looked, now)).ok).toBe(true);
    expect((await acceptConnectHandoff(store, replay, SECRET, async () => looked, now)).ok).toBe(false);

    const flipped = replay.slice(0, -2) + "aa";
    expect((await acceptConnectHandoff(store, flipped, SECRET, async () => looked, now)).ok).toBe(false);
    expect((await acceptConnectHandoff(store, replay, "other-secret", async () => looked, now)).ok).toBe(false);
  });
});

describe("owner sessions", () => {
  it("refuses a pre-fix cookie, accepts a new signed session, and sign-out invalidates only that session", () => {
    const store = memoryStore();
    const { owner } = seedProBusiness(store, { email: "owner@example.com", slug: "northwind" });
    const legacy = "11111111-1111-1111-1111-11111111111122222222-2222-2222-2222-222222222222";
    expect(verifyOwnerSession(legacy, SECRET)).toBeNull();
    expect(store.getOwnerBySession(legacy)).toBeNull();

    const kept = store.createSession(owner.id);
    const sid = store.createSession(owner.id);
    const now = Date.parse("2026-11-07T00:00:00Z");
    const exp = Math.floor(now / 1000) + OWNER_SESSION_TTL_SECONDS;
    const cookie = signOwnerSession({ sid, ownerId: owner.id, exp }, SECRET, now);
    const parsed = verifyOwnerSession(cookie, SECRET, now);
    expect(parsed).toEqual({ sid, ownerId: owner.id, exp });
    expect(store.getOwnerBySession(parsed?.sid || "")?.id).toBe(owner.id);
    expect(cookie.startsWith("s2.")).toBe(true);
    expect(verifyOwnerSession(cookie.slice(0, -1) + (cookie.endsWith("a") ? "b" : "a"), SECRET, now)).toBeNull();
    expect(verifyOwnerSession(cookie, SECRET, now + OWNER_SESSION_TTL_SECONDS * 1000 + 1000)).toBeNull();

    const payload = cookie.split(".")[1];
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sid: string; ownerId: string; exp: number };
    body.ownerId = "owner-forged";
    const swapped = `s2.${Buffer.from(JSON.stringify({ v: 2, ...body })).toString("base64url")}.${cookie.split(".")[2]}`;
    expect(verifyOwnerSession(swapped, SECRET, now)).toBeNull();

    store.deleteSession(sid);
    expect(store.getOwnerBySession(sid)).toBeNull();
    expect(store.getOwnerBySession(kept)?.id).toBe(owner.id);
  });
});

describe("portal recovery page", () => {
  it("uses the existing Schedi session and does not embed a secret or an email form", () => {
    const page = connectPortalPage();
    expect(page).toContain("schedi.authSession");
    expect(page).toContain("schedi.authMeta");
    expect(page).toContain("/billing/connect-handoff");
    expect(page).toContain("schedi-connect-production");
    expect(page).toContain("handoff#t=");
    expect(page).not.toContain("type=\"email\"");
    expect(page).not.toContain("SCHEDI_CONNECT_PAID_SECRET");
    expect(page).not.toContain(SECRET);
    const worker = readFileSync(new URL("../workers/schedi-email-worker/src/index.js", import.meta.url), "utf8");
    expect(worker).toContain("path === '/billing/connect-portal'");
    const wrangler = readFileSync(new URL("../workers/schedi-email-worker/wrangler.toml", import.meta.url), "utf8");
    expect(wrangler).toContain('class_name = "AuthRateLimit"');
    expect(wrangler).toContain('tag = "v1"');
    expect(wrangler).toContain('new_sqlite_classes = ["AuthRateLimit"]');
  });
});
