import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error plain JS worker module
import worker from "../workers/schedi-email-worker/src/index.js";

const TOKEN = "t".repeat(40);
const EXP = Date.now() + 60 * 60 * 1000;
const NEW_EMAIL = "schedi.app@gmail.com";
const PASSWORD = "first-agency-password";
const OTHER_PASSWORD = "second-agency-password";

function memoryKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
}

function agencyEnv(extra: Record<string, unknown> = {}) {
  const kv = memoryKv({
    "session:owner-token": JSON.stringify({ role: "owner", email: "owner@example.com", tenantId: "acme", exp: EXP }),
    "session:agency-token": JSON.stringify({ role: "agency", email: "hq@example.com", exp: EXP }),
  });
  return {
    kv,
    env: {
      AUTH_KV: kv,
      AUTH_PEPPER: "test-pepper",
      MIGRATION_TOKEN: TOKEN,
      ADMIN_FORWARD_RECIPIENTS: "admin@schedi.app,hello@schedi.app",
      ADMIN_FORWARD_TO: "axl199@gmail.com,schedi.app@gmail.com",
      ...extra,
    },
  };
}

type CallOpts = {
  method?: string;
  session?: "none" | "owner" | "agency" | "cookie";
  bearer?: string | null;
  env?: Record<string, unknown>;
};

async function call(body: Record<string, unknown>, opts: CallOpts = {}) {
  const { kv, env } = agencyEnv();
  const used = opts.env || env;
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "https://schedi.app" };
  const payload: Record<string, unknown> = { ...body };
  const session = opts.session || "agency";
  if (session === "owner") {
    payload.session = "owner-token";
    headers["X-Schedi-Session"] = "owner-token";
  } else if (session === "agency") {
    payload.session = "agency-token";
    headers["X-Schedi-Session"] = "agency-token";
  } else if (session === "cookie") {
    headers.Cookie = "schedi_hq=agency-token";
  }
  if (opts.bearer !== null) headers.Authorization = "Bearer " + (opts.bearer === undefined ? TOKEN : opts.bearer);
  const method = opts.method || "POST";
  const response = await worker.fetch(new Request("https://schedi.app/admin/agency-add", {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(payload),
  }), used, {});
  const text = await response.text();
  let data: { ok?: boolean; error?: string; created?: boolean } = {};
  try { data = JSON.parse(text); } catch { data = {}; }
  return { status: response.status, data, text, kv: (used.AUTH_KV as ReturnType<typeof memoryKv>) || kv };
}

function mail(to: string, fail: string[] = []) {
  const forwarded: string[] = [];
  const attempted: string[] = [];
  return {
    to,
    forwarded,
    attempted,
    forward: vi.fn(async (dest: string) => {
      attempted.push(dest);
      if (fail.includes(dest)) throw new Error("smtp down");
      forwarded.push(dest);
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /admin/agency-add", () => {
  it("requires an agency session and the migration bearer together", async () => {
    const none = await call({ email: NEW_EMAIL, password: PASSWORD }, { session: "none" });
    expect(none.status).toBe(401);
    expect(none.data.error).toBe("session_required");
    expect(none.text).not.toContain(PASSWORD);

    const owner = await call({ email: NEW_EMAIL, password: PASSWORD }, { session: "owner" });
    expect(owner.status).toBe(403);
    expect(owner.data.error).toBe("forbidden");
    expect(owner.text).not.toContain(PASSWORD);

    const noBearer = await call({ email: NEW_EMAIL, password: PASSWORD }, { bearer: null });
    expect(noBearer.status).toBe(401);
    expect(noBearer.data.error).toBe("unauthorized");

    const badBearer = await call({ email: NEW_EMAIL, password: PASSWORD }, { bearer: "n".repeat(40) });
    expect(badBearer.status).toBe(401);
    expect(badBearer.data.error).toBe("unauthorized");

    const { env } = agencyEnv();
    const unset = await call({ email: NEW_EMAIL, password: PASSWORD }, { env: { ...env, MIGRATION_TOKEN: "" } });
    expect(unset.status).toBe(401);
    expect(unset.data.error).toBe("unauthorized");

    const short = await call({ email: NEW_EMAIL, password: PASSWORD }, { env: { ...env, MIGRATION_TOKEN: "short-token" } });
    expect(short.status).toBe(401);

    const get = await call({ email: NEW_EMAIL, password: PASSWORD }, { method: "GET" });
    expect(get.status).toBe(405);
    expect(get.data.error).toBe("method_not_allowed");
    expect(get.kv.store.has("agency:" + NEW_EMAIL)).toBe(false);
  });

  it("rejects a bad email or a short password before writing a key", async () => {
    const email = await call({ email: "not-an-email", password: PASSWORD });
    expect(email.status).toBe(400);
    expect(email.data.error).toBe("invalid_email");
    expect(email.kv.put).not.toHaveBeenCalled();

    const password = await call({ email: NEW_EMAIL, password: "short" });
    expect(password.status).toBe(400);
    expect(password.data.error).toBe("invalid_password");
    expect(password.text).not.toContain("short");
    expect(password.kv.put).not.toHaveBeenCalled();
  });

  it("creates a new agency key and never overwrites an existing one", async () => {
    const { kv, env } = agencyEnv();
    const created = await call({ email: "  " + NEW_EMAIL.toUpperCase() + "  ", password: PASSWORD }, { env });
    expect(created.status).toBe(200);
    expect(created.data).toEqual({ ok: true, created: true });
    expect(created.text).not.toContain(PASSWORD);
    const stored = kv.store.get("agency:" + NEW_EMAIL);
    expect(stored).toBeTruthy();
    const record = JSON.parse(String(stored));
    expect(record.email).toBe(NEW_EMAIL);
    expect(record.hash).toBeTruthy();
    expect(JSON.stringify(record)).not.toContain(PASSWORD);

    const again = await call({ email: NEW_EMAIL, password: OTHER_PASSWORD }, { env });
    expect(again.status).toBe(200);
    expect(again.data).toEqual({ ok: true, created: false });
    expect(again.text).not.toContain(OTHER_PASSWORD);
    expect(kv.store.get("agency:" + NEW_EMAIL)).toBe(stored);

    const second = await call({ email: "axl199@gmail.com", password: OTHER_PASSWORD }, { env });
    expect(second.data).toEqual({ ok: true, created: true });
    expect(kv.store.get("agency:" + NEW_EMAIL)).toBe(stored);
    expect(kv.store.has("agency:axl199@gmail.com")).toBe(true);
  });

  it("accepts the agency cookie and leaves the password out of logs", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const out = await call({ email: NEW_EMAIL, password: PASSWORD }, { session: "cookie" });
    expect(out.data).toEqual({ ok: true, created: true });
    const logged = [console.log, console.warn, console.error, console.info]
      .map((fn) => (fn as unknown as { mock?: { calls: unknown[][] } }).mock?.calls || [])
      .flat()
      .join(" ");
    expect(logged).not.toContain(PASSWORD);
  });
});

describe("inbound admin mail fan-out", () => {
  it("forwards admin and hello to every configured destination", async () => {
    const { env } = agencyEnv();
    const admin = mail("Schedi Admin <ADMIN@schedi.app>");
    await worker.email(admin, env);
    expect(admin.forwarded).toEqual(["axl199@gmail.com", "schedi.app@gmail.com"]);

    const hello = mail("hello@schedi.app");
    await worker.email(hello, env);
    expect(hello.forwarded).toEqual(["axl199@gmail.com", "schedi.app@gmail.com"]);
  });

  it("uses the destination var and still tries the next address after a failure", async () => {
    const { env } = agencyEnv();
    env.ADMIN_FORWARD_TO = "only@example.com";
    const one = mail("admin@schedi.app");
    await worker.email(one, env);
    expect(one.forwarded).toEqual(["only@example.com"]);

    env.ADMIN_FORWARD_TO = "axl199@gmail.com,schedi.app@gmail.com";
    env.ADMIN_FORWARD_RECIPIENTS = "hello@schedi.app";
    const skippedAdmin = mail("admin@schedi.app");
    await worker.email(skippedAdmin, env);
    expect(skippedAdmin.forward).not.toHaveBeenCalled();

    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const partial = mail("hello@schedi.app", ["axl199@gmail.com"]);
    await worker.email(partial, env);
    expect(partial.attempted).toEqual(["axl199@gmail.com", "schedi.app@gmail.com"]);
    expect(partial.forwarded).toEqual(["schedi.app@gmail.com"]);
    expect(error.mock.calls.some((call) => String(call[1]) === "axl199@gmail.com")).toBe(true);
  });

  it("does not forward or reject bookings@ or onboarding@", async () => {
    const { env } = agencyEnv();
    for (const to of ["bookings@schedi.app", "onboarding@schedi.app", "Bookings <bookings@schedi.app>"]) {
      const message = mail(to);
      await worker.email(message, env);
      expect(message.forward).not.toHaveBeenCalled();
      expect("setReject" in message).toBe(false);
    }
  });

  it("keeps both address lists in wrangler vars", () => {
    const toml = readFileSync(new URL("../workers/schedi-email-worker/wrangler.toml", import.meta.url), "utf8");
    const recipients = toml.split("\n").find((line) => line.startsWith("ADMIN_FORWARD_RECIPIENTS"));
    const destinations = toml.split("\n").find((line) => line.startsWith("ADMIN_FORWARD_TO"));
    expect(recipients).toBe('ADMIN_FORWARD_RECIPIENTS = "admin@schedi.app,hello@schedi.app"');
    expect(destinations).toBe('ADMIN_FORWARD_TO = "axl199@gmail.com,schedi.app@gmail.com"');
    expect(recipients).not.toContain("bookings@");
    expect(recipients).not.toContain("onboarding@");
    expect(destinations).not.toContain("bookings@");
    expect(destinations).not.toContain("onboarding@");
    expect(toml).toContain('pattern = "schedi.app/admin/agency-add*"');
  });
});
