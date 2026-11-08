import { describe, expect, it } from "vitest";
import { connectReadyDecision, privatePatchQuery } from "../workers/schedi-email-worker/src/tenant-private.js";

describe("connect ready receiver", () => {
  it("orders observations and refuses a same-second disagreement", () => {
    expect(connectReadyDecision("2026-11-07T00:00:02.000Z", true, "2026-11-07T00:00:01.000Z", false)).toBe("stale");
    expect(connectReadyDecision("2026-11-07T00:00:02.000Z", true, "2026-11-07T00:00:02.000Z", true)).toBe("idempotent");
    expect(connectReadyDecision("2026-11-07T00:00:02.000Z", true, "2026-11-07T00:00:02.000Z", false)).toBe("tie");
    expect(connectReadyDecision("", false, "2026-11-07T00:00:02.000Z", true)).toBe("write");
  });

  it("puts the private document update time on the Firestore precondition", () => {
    const query = privatePatchQuery(
      ["stripeConnectReady", "stripeConnectObservedAt"],
      "2026-11-07T00:00:01.000Z",
    );
    expect(query).toContain("currentDocument.updateTime=");
    expect(query).toContain(encodeURIComponent("2026-11-07T00:00:01.000Z"));
    expect(privatePatchQuery(["stripeConnectReady"], "")).not.toContain("currentDocument");
  });
});
