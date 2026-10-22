import { afterEach, describe, expect, it, vi } from "vitest";

// @ts-expect-error plain JS worker module
import { buildOpsSnapshot } from "../workers/schedi-email-worker/src/ops-snapshot.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ops snapshot Gmail instructions", () => {
  it("treats a thread as answered when either Schedi Gmail sent the reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    const snap = await buildOpsSnapshot({}, {
      adminAuthHeaders: async () => {
        throw new Error("no admin");
      },
      stripeRequest: async () => ({ ok: false, status: 0, data: null }),
    });
    const note = String(snap.adminInbox.note);
    const rule = String(snap.adminInbox.unansweredRule);
    expect(note).toContain("The connector mailbox may be either schedi.app@gmail.com or axl199@gmail.com.");
    expect(note).toContain("axl199@gmail.com still receives admin@ and hello@ during the transition.");
    expect(rule).toContain("schedi.app@gmail.com or axl199@gmail.com (label SENT)");
    expect(rule).toContain("A SENT message from either address answers the thread.");
    expect(rule).toContain("older than 24h");
    expect(snap.adminInbox.query).toContain("to:admin@schedi.app");
  });
});
