import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

// @ts-expect-error plain JS worker module
import * as push from "../workers/schedi-email-worker/src/owner-push.js";

const APP = "dGVzdC1hcHAtdG9rZW4tMDAwMDAwMDAwMDAwMDAwMDAw:APA91bAppToken";
const WEB = "ZmFrZS13ZWItdG9rZW4tMDAwMDAwMDAwMDAwMDAwMDAw:APA91bWebToken";
const WEB2 = "c2Vjb25kLXdlYi10b2tlbi0wMDAwMDAwMDAwMDAwMDAw:APA91bWebToken2";

function kv(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  };
}

function ownerEnv(tenantId = "acme") {
  return {
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
    AUTH_KV: kv({ "session:s1": JSON.stringify({ role: "owner", tenantId, exp: Date.now() + 3_600_000 }) }),
  };
}

const allow = (o: string) => o === "https://schedi.app" || o.endsWith(".schedi.pages.dev");

function req(path: string, body: unknown, origin = "https://schedi.app") {
  return new Request("https://schedi.app" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(body),
  });
}

type Doc = { tokens: string[]; webTokens?: string[] };
function enc(list: string[]) { return { arrayValue: { values: list.map((stringValue) => ({ stringValue })) } }; }

/** Fake Firestore pushTokens doc + FCM endpoint. */
function fakeBackend(initial: Doc | null, fcm: (token: string) => { status: number; body?: unknown } = () => ({ status: 200 })) {
  let doc: Doc | null = initial;
  const sent: Array<{ token: string; message: any }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("fcm.googleapis.com")) {
      const message = JSON.parse(String(init?.body)).message;
      sent.push({ token: message.token, message });
      const r = fcm(message.token);
      return new Response(JSON.stringify(r.body || { name: "projects/x/messages/1" }), { status: r.status });
    }
    if (url.includes("/pushTokens/")) {
      if (!init || !init.method || init.method === "GET") {
        if (!doc) return new Response("{}", { status: 404 });
        const fields: any = { tokens: enc(doc.tokens) };
        if (doc.webTokens) fields.webTokens = enc(doc.webTokens);
        return new Response(JSON.stringify({ fields }), { status: 200 });
      }
      const f = JSON.parse(String(init.body)).fields;
      const read = (v: any) => (v?.arrayValue?.values || []).map((x: any) => x.stringValue);
      doc = { tokens: read(f.tokens), webTokens: read(f.webTokens) };
      return new Response("{}", { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  });
  return { fetchMock, sent, get doc() { return doc; } };
}

let restore: typeof fetch;
beforeEach(() => { restore = globalThis.fetch; });
afterEach(() => { globalThis.fetch = restore; vi.clearAllMocks(); });

describe("nextPushDoc", () => {
  it("keeps the app token and several browsers side by side", () => {
    let d = push.nextPushDoc({ tokens: [APP] }, { add: WEB, platform: "web" });
    d = push.nextPushDoc(d, { add: WEB2, platform: "web" });
    expect(d.tokens).toEqual([APP, WEB, WEB2]);
    expect(d.webTokens).toEqual([WEB, WEB2]);
  });
  it("re-registering moves a token to newest without duplicating it", () => {
    const d = push.nextPushDoc({ tokens: [WEB, APP], webTokens: [WEB] }, { add: WEB, platform: "web" });
    expect(d.tokens).toEqual([APP, WEB]);
    expect(d.webTokens).toEqual([WEB]);
  });
  it("removes a token from both lists", () => {
    const d = push.nextPushDoc({ tokens: [APP, WEB], webTokens: [WEB] }, { remove: [WEB] });
    expect(d).toEqual({ tokens: [APP], webTokens: [] });
  });
  it("caps the list at 20 and drops web entries that fell off", () => {
    const many = Array.from({ length: 20 }, (_, i) => "tok" + i);
    const d = push.nextPushDoc({ tokens: many, webTokens: ["tok0"] }, { add: WEB, platform: "web" });
    expect(d.tokens).toHaveLength(20);
    expect(d.tokens[19]).toBe(WEB);
    expect(d.webTokens).toEqual([WEB]);
  });
});

describe("buildFcmMessage", () => {
  const meta = { kind: "new", tenantId: "acme", bookingId: "BK-0BC6FEE5", date: "2026-10-19", tag: "booking-BK-0BC6FEE5-new" };
  const LINK = "https://schedi.app/login?booking=BK-0BC6FEE5";
  it("gives web tokens a webpush notification with icon and a deep link to the booking", () => {
    const m = push.buildFcmMessage(WEB, true, { title: "New booking", body: "Ana, Cut, Fri Oct 16 2:00 PM" }, meta);
    expect(m.notification).toBeUndefined();
    expect(m.android).toBeUndefined();
    expect(m.webpush.notification).toMatchObject({ title: "New booking", body: "Ana, Cut, Fri Oct 16 2:00 PM", icon: "https://schedi.app/assets/homescreen-icon.png", tag: "booking-BK-0BC6FEE5-new" });
    expect(m.webpush.fcm_options.link).toBe(LINK);
    expect(m.data).toEqual({ kind: "new", tenantId: "acme", bookingId: "BK-0BC6FEE5", date: "2026-10-19", url: LINK });
  });
  it("gives the Android app the booking id, date and deep link in data", () => {
    const m = push.buildFcmMessage(APP, false, { title: "New booking", body: "x" }, meta);
    expect(m.notification).toEqual({ title: "New booking", body: "x" });
    expect(m.android).toEqual({ priority: "HIGH", notification: { sound: "default", tag: "booking-BK-0BC6FEE5-new" } });
    expect(m.webpush).toBeUndefined();
    expect(m.data).toEqual({ kind: "new", tenantId: "acme", bookingId: "BK-0BC6FEE5", date: "2026-10-19", url: LINK });
  });
  it("falls back to the plain portal link without a usable booking id", () => {
    const t = push.buildFcmMessage(WEB, true, { title: "t", body: "b" }, { kind: "test", tenantId: "acme", bookingId: "", tag: "schedi-test" });
    expect(t.webpush.fcm_options.link).toBe("https://schedi.app/login");
    expect(t.data.bookingId).toBe("");
    expect(t.data.date).toBe("");
    const bad = push.buildFcmMessage(APP, false, { title: "t", body: "b" }, { kind: "new", tenantId: "acme", bookingId: "x/../y?z", date: "soon", tag: "x" });
    expect(bad.data.url).toBe("https://schedi.app/login");
    expect(bad.data.bookingId).toBe("");
    expect(bad.data.date).toBe("");
  });
});

describe("isDeadTokenError", () => {
  it("prunes unregistered and not-found tokens", () => {
    expect(push.isDeadTokenError(404, { error: { status: "NOT_FOUND" } })).toBe(true);
    expect(push.isDeadTokenError(400, { error: { details: [{ errorCode: "UNREGISTERED" }] } })).toBe(true);
    expect(push.isDeadTokenError(400, { error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" } })).toBe(true);
  });
  it("keeps tokens on payload errors and outages", () => {
    expect(push.isDeadTokenError(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid value at 'message.webpush.notification'" } })).toBe(false);
    expect(push.isDeadTokenError(503, { error: { status: "UNAVAILABLE" } })).toBe(false);
    expect(push.isDeadTokenError(429, { error: { status: "QUOTA_EXCEEDED" } })).toBe(false);
  });
});

describe("POST /api/push-token", () => {
  it("registers a web token next to the app token", async () => {
    const be = fakeBackend({ tokens: [APP] });
    globalThis.fetch = be.fetchMock as any;
    const res = await push.handlePushTokenHttp(req("/api/push-token", { action: "register", session: "s1", tenantId: "acme", token: WEB, platform: "web" }), ownerEnv(), "https://schedi.app", { isAllowedOrigin: allow });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, count: 2, registered: true });
    expect(be.doc).toEqual({ tokens: [APP, WEB], webTokens: [WEB] });
  });
  it("accepts the preview origin", async () => {
    const be = fakeBackend(null);
    globalThis.fetch = be.fetchMock as any;
    const o = "https://push-preview.schedi.pages.dev";
    const res = await push.handlePushTokenHttp(req("/api/push-token", { session: "s1", tenantId: "acme", token: WEB, platform: "web" }, o), ownerEnv(), o, { isAllowedOrigin: allow });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(o);
  });
  it("unregisters a web token", async () => {
    const be = fakeBackend({ tokens: [APP, WEB], webTokens: [WEB] });
    globalThis.fetch = be.fetchMock as any;
    const res = await push.handlePushTokenHttp(req("/api/push-token", { action: "unregister", session: "s1", tenantId: "acme", token: WEB, platform: "web" }), ownerEnv(), "https://schedi.app", { isAllowedOrigin: allow });
    expect(await res.json()).toMatchObject({ ok: true, count: 1, registered: false });
    expect(be.doc).toEqual({ tokens: [APP], webTokens: [] });
  });
  it("refuses another business and missing sessions", async () => {
    globalThis.fetch = fakeBackend(null).fetchMock as any;
    const other = await push.handlePushTokenHttp(req("/api/push-token", { session: "s1", tenantId: "other", token: WEB }), ownerEnv(), "https://schedi.app", { isAllowedOrigin: allow });
    expect(other.status).toBe(403);
    const none = await push.handlePushTokenHttp(req("/api/push-token", { session: "nope", tenantId: "acme", token: WEB }), ownerEnv(), "https://schedi.app", { isAllowedOrigin: allow });
    expect(none.status).toBe(401);
  });
});

describe("POST /api/push-test", () => {
  const deps = { isAllowedOrigin: allow, rateLimitOk: async () => true };
  it("sends one webpush alert to this device only, then cools down", async () => {
    const be = fakeBackend({ tokens: [APP, WEB], webTokens: [WEB] });
    globalThis.fetch = be.fetchMock as any;
    const env = ownerEnv();
    const res = await push.handlePushTestHttp(req("/api/push-test", { session: "s1", tenantId: "acme", token: WEB }), env, "https://schedi.app", deps);
    expect(res.status).toBe(200);
    expect(be.sent.map((s) => s.token)).toEqual([WEB]);
    expect(be.sent[0].message.webpush.notification.title).toBe("Booking alerts are on");
    const again = await push.handlePushTestHttp(req("/api/push-test", { session: "s1", tenantId: "acme", token: WEB }), env, "https://schedi.app", deps);
    expect(again.status).toBe(429);
    expect(be.sent).toHaveLength(1);
  });
  it("will not send to a token that is not registered for the business", async () => {
    const be = fakeBackend({ tokens: [APP], webTokens: [] });
    globalThis.fetch = be.fetchMock as any;
    const res = await push.handlePushTestHttp(req("/api/push-test", { session: "s1", tenantId: "acme", token: WEB }), ownerEnv(), "https://schedi.app", deps);
    expect(res.status).toBe(404);
    expect(be.sent).toHaveLength(0);
  });
  it("requires the owner of that business", async () => {
    globalThis.fetch = fakeBackend({ tokens: [WEB], webTokens: [WEB] }).fetchMock as any;
    const res = await push.handlePushTestHttp(req("/api/push-test", { session: "s1", tenantId: "other", token: WEB }), ownerEnv(), "https://schedi.app", deps);
    expect(res.status).toBe(403);
  });
});

describe("sendOwnerPush", () => {
  it("sends app and web payloads and prunes dead tokens", async () => {
    const be = fakeBackend({ tokens: [APP, WEB, WEB2], webTokens: [WEB, WEB2] }, (t) =>
      t === WEB2 ? { status: 404, body: { error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } } } : { status: 200 });
    globalThis.fetch = be.fetchMock as any;
    const r = await push.sendOwnerPush(ownerEnv(), "acme", { id: "b1", clientName: "Ana", serviceName: "Cut", date: "2026-10-16", time: "2:00 PM" }, "new");
    expect(r).toMatchObject({ ok: true, sent: 2 });
    const byToken = Object.fromEntries(be.sent.map((s) => [s.token, s.message]));
    expect(byToken[APP].android).toBeDefined();
    expect(byToken[WEB].webpush.notification.body).toBe("Ana, Cut, Fri, Oct 16 2:00 PM");
    expect(be.doc).toEqual({ tokens: [APP, WEB], webTokens: [WEB] });
  });
  it("reads docs written before web push (tokens only) as app tokens", async () => {
    const be = fakeBackend({ tokens: [APP] });
    globalThis.fetch = be.fetchMock as any;
    await push.sendOwnerPush(ownerEnv(), "acme", { id: "b2" }, "cancel");
    expect(be.sent[0].message.android).toBeDefined();
    expect(be.sent[0].message.notification.title).toBe("Booking cancelled");
  });
});
