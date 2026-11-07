import { describe, expect, it } from "vitest";
import { handleAuthRequest, saveOwnerSecret } from "../workers/schedi-email-worker/src/owner-auth.js";

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function memoryKv() {
  const map = new Map<string, string>();
  let writes = 0;
  return {
    writes: () => writes,
    async get(key: string) {
      return map.has(key) ? map.get(key)! : null;
    },
    async put(key: string, value: string) {
      writes += 1;
      map.set(key, value);
    },
    async delete(key: string) {
      writes += 1;
      map.delete(key);
    },
  };
}

describe("/auth/rename", () => {
  it("denies owner and agency before any credential write, including a destination with no credential", async () => {
    const kv = memoryKv();
    const env = { AUTH_KV: kv, AUTH_PEPPER: "pepper" };
    expect((await saveOwnerSecret(env, "attacker@example.com", "attacker-shop", "password1")).ok).toBe(true);
    const before = await kv.get("tenant:attacker-shop");
    const writesAfterSetup = kv.writes();
    await kv.put("session:owner", JSON.stringify({
      exp: Date.now() + 60_000,
      role: "owner",
      email: "attacker@example.com",
      tenantId: "attacker-shop",
    }));
    await kv.put("session:agency", JSON.stringify({
      exp: Date.now() + 60_000,
      role: "agency",
      email: "hq@example.com",
    }));
    const armed = kv.writes();

    for (const session of ["owner", "agency"]) {
      const response = await handleAuthRequest(new Request("https://schedi.app/auth/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session, fromId: "attacker-shop", toId: "harbor-cuts" }),
      }), env, "https://schedi.app", "/auth/rename", json, {});
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: "rename_disabled" });
    }

    expect(kv.writes()).toBe(armed);
    expect(await kv.get("tenant:attacker-shop")).toBe(before);
    expect(await kv.get("tenant:harbor-cuts")).toBeNull();
    expect(writesAfterSetup).toBeGreaterThan(0);
  });
});
