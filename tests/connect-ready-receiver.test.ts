import { describe, expect, it } from "vitest";
import { applyConnectReadyWrite, connectReadyDecision, privatePatchQuery } from "../workers/schedi-email-worker/src/tenant-private.js";

const NEWER = "2026-11-07T00:00:02.000Z";
const OLDER = "2026-11-07T00:00:01.000Z";

describe("connect ready receiver", () => {
  it("rejects a blank observation instead of writing over a fence", () => {
    expect(connectReadyDecision(NEWER, true, "", false)).toBe("reject");
    expect(connectReadyDecision(NEWER, true, "not-a-time", false)).toBe("reject");
    expect(connectReadyDecision(NEWER, true, OLDER, false)).toBe("stale");
    expect(connectReadyDecision(NEWER, true, NEWER, true)).toBe("idempotent");
    expect(connectReadyDecision(NEWER, true, NEWER, false)).toBe("tie");
    expect(connectReadyDecision("", false, NEWER, true)).toBe("write");
  });

  it("uses exists=false for a create and updateTime for an existing document", () => {
    expect(privatePatchQuery(["stripeConnectReady"], { exists: false })).toContain("currentDocument.exists=false");
    expect(privatePatchQuery(["stripeConnectReady"], { exists: false })).not.toContain("updateTime");
    const update = privatePatchQuery(["stripeConnectObservedAt"], { updateTime: OLDER });
    expect(update).toContain("currentDocument.updateTime=");
    expect(update).toContain(encodeURIComponent(OLDER));
    expect(privatePatchQuery(["stripeConnectReady"], {})).not.toContain("currentDocument");
  });

  it("does not write when the private document failed to load", async () => {
    let writes = 0;
    const result = await applyConnectReadyWrite({
      observedAt: NEWER,
      ready: false,
      statusText: "in_progress",
      read: async () => ({ privateLoadFailed: true, observedAt: "", ready: true, updateTime: "", statusText: "ready" }),
      write: async () => {
        writes += 1;
      },
    });
    expect(result).toMatchObject({ ok: false, status: 503, error: "private_read_failed" });
    expect(writes).toBe(0);
  });

  it("does not let a blank observation erase a stored fence", async () => {
    let writes = 0;
    const result = await applyConnectReadyWrite({
      observedAt: "",
      ready: false,
      statusText: "in_progress",
      read: async () => ({ observedAt: NEWER, ready: true, updateTime: "t1", statusText: "ready" }),
      write: async () => {
        writes += 1;
      },
    });
    expect(result).toMatchObject({ ok: false, status: 400, error: "observed_at_required" });
    expect(writes).toBe(0);
  });

  it("creates a missing document once and reloads a conflicting create", async () => {
    let doc: { observedAt: string; ready: boolean; updateTime: string } | null = null;
    let creates = 0;
    const write = async (next: { observedAt: string; ready: boolean; create?: boolean; updateTime?: string }) => {
      if (next.create) {
        creates += 1;
        if (doc) throw new Error("private_tenant_write_failed:409");
        doc = { observedAt: next.observedAt, ready: next.ready, updateTime: "created" };
        return;
      }
      if (!doc || doc.updateTime !== next.updateTime) throw new Error("private_tenant_write_failed:409");
      doc = { observedAt: next.observedAt, ready: next.ready, updateTime: "created-2" };
    };
    const read = async () => doc
      ? { observedAt: doc.observedAt, ready: doc.ready, updateTime: doc.updateTime, statusText: doc.ready ? "ready" : "in_progress" }
      : { observedAt: "", ready: false, updateTime: "", statusText: "" };
    const first = await applyConnectReadyWrite({
      observedAt: NEWER,
      ready: true,
      statusText: "ready",
      read,
      write,
    });
    const second = await applyConnectReadyWrite({
      observedAt: OLDER,
      ready: false,
      statusText: "in_progress",
      read,
      write,
    });
    expect(first).toMatchObject({ ok: true, ready: true });
    expect(second).toMatchObject({ ok: true, stale: true, ready: true });
    expect(creates).toBe(1);
    expect(doc).toMatchObject({ observedAt: NEWER, ready: true });
  });

  it("repairs a public projection that does not match the private observation", async () => {
    let writes = 0;
    const result = await applyConnectReadyWrite({
      observedAt: NEWER,
      ready: true,
      statusText: "ready",
      read: async () => ({
        privateObservedAt: NEWER,
        privateStatus: "ready",
        privateUpdateTime: "private-1",
        privateExists: true,
        publicReady: false,
        publicObservedAt: OLDER,
        publicUpdateTime: "public-1",
        publicExists: true,
      }),
      write: async (next: { repair?: boolean; create?: boolean; publicUpdateTime?: string }) => {
        writes += 1;
        expect(next.repair).toBe(true);
        expect(next.create).toBe(false);
        expect(next.publicUpdateTime).toBe("public-1");
      },
    });
    expect(result).toMatchObject({ ok: true, ready: true });
    expect(writes).toBe(1);
  });

  it("reloads after a lost create and keeps the observation that landed first", async () => {
    let landed = false;
    const result = await applyConnectReadyWrite({
      observedAt: OLDER,
      ready: false,
      statusText: "in_progress",
      read: async () => landed
        ? { observedAt: NEWER, ready: true, updateTime: "t2", statusText: "ready" }
        : { observedAt: "", ready: false, updateTime: "", statusText: "" },
      write: async (next: { create?: boolean }) => {
        expect(next.create).toBe(true);
        landed = true;
        throw new Error("private_tenant_write_failed:409");
      },
    });
    expect(result).toMatchObject({ ok: true, stale: true, ready: true });
  });
});
