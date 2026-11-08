import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../workers/schedi-email-worker/src/firebase-admin.js", () => ({
  adminAccessToken: vi.fn(async () => "access"),
  adminAuthHeaders: vi.fn(async () => ({ Authorization: "Bearer access", "Content-Type": "application/json" })),
}));

import worker from "../workers/schedi-email-worker/src/index.js";

const TENANT = "northwind";
const OLDER = "2026-11-07T00:00:01.000Z";
const NEWER = "2026-11-07T00:00:02.000Z";

type Fields = Record<string, string | boolean>;
type Doc = { updateTime: string; fields: Fields } | null;

function encodeFields(fields: Fields) {
  const encoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    encoded[key] = typeof value === "boolean" ? { booleanValue: value } : { stringValue: value };
  }
  return encoded;
}

function decodeFields(fields: Record<string, { stringValue?: string; booleanValue?: boolean }> | undefined): Fields {
  const out: Fields = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (typeof value?.booleanValue === "boolean") out[key] = value.booleanValue;
    else if (typeof value?.stringValue === "string") out[key] = value.stringValue;
  }
  return out;
}

function kv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
  };
}

function env() {
  return {
    FIREBASE_API_KEY: "test-key",
    FIREBASE_PROJECT_ID: "siteforge-97699",
    FIREBASE_APP_ID: "siteforge-97699",
    SCHEDI_CONNECT_PAID_SECRET: "connect-secret",
    AUTH_KV: kv(),
  };
}

function pairStore(initial: { public: Doc; private: Doc }) {
  const docs = {
    public: initial.public ? { updateTime: initial.public.updateTime, fields: { ...initial.public.fields } } : null,
    private: initial.private ? { updateTime: initial.private.updateTime, fields: { ...initial.private.fields } } : null,
  };
  let clock = 0;
  let commits = 0;
  let patches = 0;
  let releaseFirst: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markHeld: () => void = () => {};
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  let failNext = false;

  function docResponse(doc: Doc) {
    if (!doc) return new Response("{}", { status: 404 });
    return Response.json({ updateTime: doc.updateTime, fields: encodeFields(doc.fields) });
  }

  function applyCommit(body: { writes?: Array<{ update?: { name?: string; fields?: Record<string, { stringValue?: string; booleanValue?: boolean }> }; currentDocument?: { exists?: boolean; updateTime?: string } }> }) {
    const writes = body.writes || [];
    if (writes.length !== 2) return new Response("one commit must contain both documents", { status: 400 });
    const next = {
      public: docs.public ? { updateTime: docs.public.updateTime, fields: { ...docs.public.fields } } : null,
      private: docs.private ? { updateTime: docs.private.updateTime, fields: { ...docs.private.fields } } : null,
    };
    for (const write of writes) {
      const name = String(write.update?.name || "");
      const kind = name.includes("/private/data/") ? "private" : "public";
      const current = docs[kind];
      const precondition = write.currentDocument || {};
      const ok = precondition.exists === false
        ? current == null
        : Boolean(precondition.updateTime && current && current.updateTime === precondition.updateTime);
      if (!ok) return new Response(JSON.stringify({ error: { status: "FAILED_PRECONDITION" } }), { status: 409 });
      clock += 1;
      next[kind] = { updateTime: "t" + clock, fields: { ...(current?.fields || {}), ...decodeFields(write.update?.fields) } };
    }
    docs.public = next.public;
    docs.private = next.private;
    return Response.json({ writeResults: [{}, {}] });
  }

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = String(init?.method || "GET").toUpperCase();
    if (url.includes("identitytoolkit.googleapis.com")) return Response.json({ idToken: "tok" });
    if (method === "PATCH") {
      patches += 1;
      return new Response("split patch", { status: 500 });
    }
    if (url.endsWith(":commit") && method === "POST") {
      commits += 1;
      const body = JSON.parse(String(init?.body || "{}"));
      if (commits === 1 && failNext) {
        failNext = false;
        return new Response("commit failed", { status: 500 });
      }
      if (commits === 1 && pairStoreHold.holdFirst) {
        markHeld();
        await firstHeld;
      }
      return applyCommit(body);
    }
    if (url.includes("/private/data/tenants/")) return docResponse(docs.private);
    if (url.includes("/public/data/tenants/")) return docResponse(docs.public);
    return new Response("unexpected " + url, { status: 500 });
  });

  return { docs, fetchImpl, held, releaseFirst, patches: () => patches, commits: () => commits, failNext: () => { failNext = true; } };
}

const pairStoreHold = { holdFirst: false };

function readyRequest(observedAt: string, ready: boolean) {
  return new Request("https://schedi.app/billing/connect-ready", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-schedi-connect-secret": "connect-secret" },
    body: JSON.stringify({ slug: TENANT, ready, observedAt }),
  });
}

describe("connect ready pair commit", () => {
  afterEach(() => {
    pairStoreHold.holdFirst = false;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not let an older callback overwrite a newer public flag, and a failed commit changes neither document", async () => {
    pairStoreHold.holdFirst = true;
    const store = pairStore({
      public: { updateTime: "pub-0", fields: { id: TENANT, slug: TENANT, stripeConnectReady: false } },
      private: null,
    });
    store.failNext();
    vi.stubGlobal("fetch", store.fetchImpl);
    const crashed = await worker.fetch(readyRequest(OLDER, true), env(), { waitUntil() {} });
    expect(crashed.status).toBe(502);
    expect(store.docs.private).toBeNull();
    expect(store.docs.public?.fields.stripeConnectReady).toBe(false);
    expect(store.patches()).toBe(0);

    pairStoreHold.holdFirst = true;
    const race = pairStore({
      public: { updateTime: "pub-0", fields: { id: TENANT, slug: TENANT, stripeConnectReady: false } },
      private: null,
    });
    vi.stubGlobal("fetch", race.fetchImpl);
    const older = worker.fetch(readyRequest(OLDER, true), env(), { waitUntil() {} });
    await race.held;
    const newer = await worker.fetch(readyRequest(NEWER, false), env(), { waitUntil() {} });
    race.releaseFirst();
    const olderResult = await older;
    expect(newer.status).toBe(200);
    expect(await newer.json()).toMatchObject({ stripeConnectReady: false, stale: false });
    expect(olderResult.status).toBe(200);
    expect(await olderResult.json()).toMatchObject({ stale: true, stripeConnectReady: false });
    expect(race.docs.private?.fields).toMatchObject({ stripeConnectObservedAt: NEWER, stripeConnectStatus: "in_progress" });
    expect(race.docs.public?.fields).toMatchObject({ stripeConnectReady: false, stripeConnectObservedAt: NEWER });
    expect(race.patches()).toBe(0);
  });

  it("retries a stranded public projection in the same commit as the private observation", async () => {
    const store = pairStore({
      public: { updateTime: "pub-0", fields: { id: TENANT, slug: TENANT, stripeConnectReady: false, stripeConnectObservedAt: "" } },
      private: { updateTime: "priv-0", fields: { stripeConnectStatus: "ready", stripeConnectObservedAt: NEWER } },
    });
    store.failNext();
    vi.stubGlobal("fetch", store.fetchImpl);
    const failed = await worker.fetch(readyRequest(NEWER, true), env(), { waitUntil() {} });
    expect(failed.status).toBe(502);
    expect(store.docs.public?.fields.stripeConnectReady).toBe(false);
    const repaired = await worker.fetch(readyRequest(NEWER, true), env(), { waitUntil() {} });
    expect(repaired.status).toBe(200);
    expect(store.docs.private?.fields).toMatchObject({ stripeConnectStatus: "ready", stripeConnectObservedAt: NEWER });
    expect(store.docs.public?.fields).toMatchObject({ stripeConnectReady: true, stripeConnectObservedAt: NEWER });
    expect(store.patches()).toBe(0);
  });
});
