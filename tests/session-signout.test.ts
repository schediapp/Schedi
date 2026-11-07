import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const cookieJar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = cookieJar.get(name);
      return value === undefined ? undefined : { value };
    },
  }),
}));

process.env.SCHEDI_DB_PATH = join(mkdtempSync(join(tmpdir(), "schedi-session-")), "schedi.sqlite");
process.env.SCHEDI_CONNECT_PAID_SECRET = "paid-secret";
process.env.SCHEDI_SEED = "0";
process.env.NODE_ENV = "production";

afterEach(() => {
  cookieJar.clear();
});

describe("Railway session route on the deployed schema", () => {
  it("refuses email sign-in, still signs out, and still opens a session from a verified handoff", async () => {
    const { POST: sessionPost } = await import("../src/app/api/session/route");
    const { POST: handoffPost } = await import("../src/app/api/connect/handoff/route");
    const { signConnectHandoff } = await import("../workers/schedi-email-worker/src/connect-handoff.js");
    const { getStore } = await import("../src/lib/store");
    const store = getStore();

    const taken = await sessionPost(new Request("https://schedi-connect-production.up.railway.app/api/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "intent=sign-in&email=owner@example.com&owner_name=Ada&business_name=Engines",
    }));
    expect(taken.status).toBe(303);
    expect(taken.headers.get("set-cookie")).toBeNull();
    expect(taken.headers.get("location") || "").toContain("email");
    expect(store.getOwnerByEmail("owner@example.com")).toBeNull();

    const token = await signConnectHandoff({
      v: 1,
      slug: "northwind",
      email: "owner@example.com",
      ownerName: "Ada",
      businessName: "Engines",
      nonce: "nonce-handoff-railway-01",
      exp: Math.floor(Date.now() / 1000) + 60,
    }, "paid-secret");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      slug: "northwind",
      name: "Engines",
      ownerEmail: "owner@example.com",
      ownerName: "Ada",
      plan: "pro",
      subscriptionStatus: "active",
      cardEntitled: true,
    }), { status: 200 }));
    try {
      const handed = await handoffPost(new Request("https://schedi-connect-production.up.railway.app/api/connect/handoff", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: token }),
      }));
      expect(handed.status).toBe(303);
      expect(handed.headers.get("set-cookie") || "").toContain("schedi_session=");
      expect(handed.headers.get("location") || "").toContain("/portal");
      expect(store.getOwnerByEmail("owner@example.com")?.email).toBe("owner@example.com");
    } finally {
      fetchSpy.mockRestore();
    }

    const owner = store.getOwnerByEmail("owner@example.com");
    const { OWNER_SESSION_TTL_SECONDS, signOwnerSession } = await import("../src/lib/owner-session");
    const sid = store.createSession(owner!.id);
    expect(store.getOwnerBySession("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeeeaaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")).toBeNull();
    expect(store.getOwnerBySession(sid)?.id).toBe(owner!.id);
    cookieJar.set("schedi_session", signOwnerSession({
      sid,
      ownerId: owner!.id,
      exp: Math.floor(Date.now() / 1000) + OWNER_SESSION_TTL_SECONDS,
    }, "paid-secret"));
    const signedOut = await sessionPost(new Request("https://schedi-connect-production.up.railway.app/api/session", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "intent=sign-out",
    }));
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("set-cookie") || "").toContain("Max-Age=0");
    expect(store.getOwnerBySession(sid)).toBeNull();
    expect(signedOut.headers.get("location") || "").not.toContain("s2.");
  });
});
