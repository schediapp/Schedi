import { afterEach, describe, expect, it, vi } from "vitest";

// Importing worker/page-visits.ts used to call crypto.getRandomValues while the
// module was still loading. Cloudflare rejects that upload with error 10021.
// This file must not statically import that module: the spy has to be in place
// before the module body runs.

describe("page visit module load", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("does not call crypto when schedi-web or the email worker imports it", async () => {
    const hits: string[] = [];
    vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
      hits.push(new Error("getRandomValues").stack || "getRandomValues");
      return array;
    });
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      hits.push(new Error("randomUUID").stack || "randomUUID");
      return "00000000-0000-4000-8000-000000000000";
    });
    vi.resetModules();
    await import("../worker/page-visits.ts");
    await import("../worker/handler.ts");
    await import("../worker/index.ts");
    await import("../workers/schedi-email-worker/src/index.js");
    expect(hits).toEqual([]);
  });
});
