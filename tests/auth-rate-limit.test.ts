import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../workers/schedi-email-worker/src/index.js";
import { hitAuthLimits } from "../workers/schedi-email-worker/src/auth-rate-limit.js";
import { resetLocalLimits } from "../workers/schedi-email-worker/src/rate-limit.js";
import { memoryAuthLimits } from "./memory-auth-limit";

function memoryStorage() {
  const store = new Map<string, unknown>();
  const storage = {
    async get(key: string) {
      return store.has(key) ? store.get(key) : undefined;
    },
    async put(key: string, value: unknown) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async transaction<T>(fn: (txn: typeof storage) => Promise<T>) {
      return fn(storage);
    },
  };
  return { storage, store };
}

describe("auth rate limit counter", () => {
  it("allows 5 emails per route per 60s and reports Retry-After from the oldest hit", async () => {
    const { storage } = memoryStorage();
    const email = { key: "/auth/tenant|email:abc", dimension: "email" };
    for (let i = 0; i < 5; i += 1) {
      const out = await hitAuthLimits(storage, [email], i * 1000);
      expect(out.ok).toBe(true);
    }
    const blocked = await hitAuthLimits(storage, [email], 5000);
    expect(blocked).toEqual({ ok: false, retryAfter: 55, limits: ["email"] });
    const still = await hitAuthLimits(storage, [email], 59999);
    expect(still.ok).toBe(false);
    // The rejected hit is not stored, so the t=0 sample has aged out.
    const open = await hitAuthLimits(storage, [email], 60000);
    expect(open.ok).toBe(true);
  });

  it("caps an IP at 10 and keeps routes on separate keys", async () => {
    const { storage, store } = memoryStorage();
    const ip = { key: "/auth/tenant|ip:203.0.113.10", dimension: "ip" };
    for (let i = 0; i < 10; i += 1) {
      expect((await hitAuthLimits(storage, [ip], 1000)).ok).toBe(true);
    }
    const blocked = await hitAuthLimits(storage, [ip], 1000);
    expect(blocked.ok).toBe(false);
    expect(blocked.limits).toEqual(["ip"]);
    const otherRoute = { key: "/auth/agency|ip:203.0.113.10", dimension: "ip" };
    expect((await hitAuthLimits(storage, [otherRoute], 1000)).ok).toBe(true);
    expect((await hitAuthLimits(storage, [{ key: ip.key, dimension: "ip", limit: 1 }], 1500)).ok).toBe(false);
    expect([...store.keys()].every((key) => !key.includes("@"))).toBe(true);
  });

  it("forgets samples older than 60 seconds", async () => {
    const limits = memoryAuthLimits();
    const now = Date.now();
    limits.store.set("/auth/tenant|ip:old", [now - 120000]);
    limits.store.set("/auth/tenant|ip:new", [now]);
    const response = await limits.namespace.getByName("auth").fetch("https://auth-rate-limit/hit", {
      method: "POST",
      body: JSON.stringify({ checks: [] }),
    });
    expect(response.ok).toBe(true);
    expect(limits.store.has("/auth/tenant|ip:old")).toBe(false);
    expect(limits.store.get("/auth/tenant|ip:new")).toEqual([now]);
  });

  it("logs both keys when the IP and the email are already full", async () => {
    const { storage } = memoryStorage();
    const checks = [
      { key: "/auth/tenant|ip:203.0.113.10", dimension: "ip" },
      { key: "/auth/tenant|email:abc", dimension: "email" },
    ];
    for (let i = 0; i < 10; i += 1) await hitAuthLimits(storage, [checks[0]], 0);
    for (let i = 0; i < 5; i += 1) await hitAuthLimits(storage, [checks[1]], 0);
    const blocked = await hitAuthLimits(storage, checks, 0);
    expect(blocked.ok).toBe(false);
    expect(blocked.limits).toEqual(["ip", "email"]);
    expect(blocked.retryAfter).toBe(60);
  });
});

describe("sign-in routes", () => {
  const password = "s3cret-password-should-not-log";
  const email = "Owner@Example.com";

  beforeEach(() => {
    resetLocalLimits();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetLocalLimits();
  });

  function logged() {
    return [console.log, console.warn, console.error, console.info]
      .map((fn) => (fn as unknown as { mock?: { calls: unknown[][] } }).mock?.calls || [])
      .flat()
      .join(" ");
  }

  function kvEnv(extra: Record<string, unknown> = {}) {
    const gets: string[] = [];
    const store = new Map<string, string>();
    return {
      gets,
      env: {
        AUTH_KV: {
          get: async (key: string) => {
            gets.push(key);
            return store.get(key) ?? null;
          },
          put: async (key: string, value: string) => { store.set(key, value); },
          delete: async (key: string) => { store.delete(key); },
        },
        AUTH_PEPPER: "test-pepper",
        ...extra,
      },
    };
  }

  async function post(env: Record<string, unknown>, path: string, body: Record<string, unknown>, ip: string) {
    const response = await worker.fetch(new Request("https://schedi.app" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip, Origin: "https://schedi.app" },
      body: JSON.stringify(body),
    }), env, { waitUntil() {} });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data: data as { error?: string }, retryAfter: response.headers.get("Retry-After") };
  }

  it("shares one counter across calls and stops before the password check", async () => {
    const limits = memoryAuthLimits();
    const bag = kvEnv({ AUTH_RATE_LIMIT: limits.namespace });
    const body = { email, password };
    for (let i = 0; i < 5; i += 1) {
      resetLocalLimits();
      const out = await post(bag.env, "/auth/tenant", body, "203.0.113." + (10 + i));
      expect(out.status).toBe(401);
    }
    const before = bag.gets.length;
    resetLocalLimits();
    const blocked = await post(bag.env, "/auth/tenant", body, "198.51.100.20");
    expect(blocked.status).toBe(429);
    expect(blocked.data.error).toBe("rate_limited");
    expect(blocked.retryAfter).toMatch(/^(?:[1-9]|[1-5]\d|60)$/);
    expect(bag.gets.length).toBe(before);
    expect(new Set(limits.names)).toEqual(new Set(["auth"]));
    const hash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
    const keys = [...limits.store.keys()].join(" ");
    expect(keys).toContain("/auth/tenant|email:" + hash);
    expect(keys).not.toContain(email);
    expect(keys).not.toContain(email.toLowerCase());
    expect(limits.bodies.join(" ")).not.toContain(email.toLowerCase());
    expect(limits.bodies.join(" ")).not.toContain(password);
    expect(logged()).toContain("auth rate limit /auth/tenant email");
    expect(logged()).not.toContain(email.toLowerCase());
    expect(logged()).not.toContain(password);
    const agency = await post(bag.env, "/auth/agency", body, "203.0.113.200");
    expect(agency.status).toBe(401);
  });

  it("fails open when the counter is missing or throws, and logs that without the email", async () => {
    const body = { email, password };
    const missing = kvEnv();
    for (let i = 0; i < 12; i += 1) {
      const out = await post(missing.env, "/auth/tenant", body, "203.0.113.8");
      expect(out.status).toBe(401);
      expect(out.retryAfter).toBeNull();
    }
    expect(logged()).toContain("auth rate limit unavailable");
    expect(logged()).not.toContain(email.toLowerCase());
    expect(logged()).not.toContain(password);

    vi.mocked(console.warn).mockClear();
    vi.mocked(console.log).mockClear();
    const broken = kvEnv({
      AUTH_RATE_LIMIT: {
        getByName() {
          return {
            fetch: async () => {
              throw new Error("counter down " + email + " " + password);
            },
          };
        },
      },
    });
    const out = await post(broken.env, "/auth/agency", body, "203.0.113.9");
    expect(out.status).toBe(401);
    expect(logged()).toContain("auth rate limit unavailable");
    expect(logged()).not.toContain(email.toLowerCase());
    expect(logged()).not.toContain(password);

    const httpDown = kvEnv({
      AUTH_RATE_LIMIT: {
        getByName() {
          return { fetch: async () => new Response("nope", { status: 500 }) };
        },
      },
    });
    const down = await post(httpDown.env, "/auth/agency", body, "203.0.113.11");
    expect(down.status).toBe(401);
    expect(logged()).toContain("auth rate limit unavailable");
  });
});
