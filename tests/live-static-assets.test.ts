import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Exact production bytes from schedi.app on 2026-10-20. A clean checkout
// must contain these; they are referenced by the shell and were previously
// only present as untracked files in local deploy directories.
const LIVE_ASSETS: Record<string, string> = {
  "site/favicon.ico": "1404d6bbc7ab2c433e72d0988f6cf80f7a8d5900b3fd87dc6498b31c4d928c43",
  "site/manifest.json": "9c4b502b1ada9b0495f134c514a026ab72a5135516eb480c4aef562a80030ee0",
  "site/manifest.webmanifest": "9c4b502b1ada9b0495f134c514a026ab72a5135516eb480c4aef562a80030ee0",
  "site/assets/logo-dark.svg": "c1daedb097f2d68f0e023dda65218f915a0f68f035def176913a804d80264e46",
  "site/assets/logo-light.svg": "1bf8b24093cef65a6d279b266feb61dbbf1a2edb60a34cbcb8c9d331fb15c623",
};

describe("live static assets", () => {
  for (const [path, sha256] of Object.entries(LIVE_ASSETS)) {
    it(`${path} is tracked at the production sha256`, () => {
      const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
      const ignored = spawnSync("git", ["check-ignore", "-q", "--", path], { encoding: "utf8" });
      expect(ignored.status).toBe(1);
    });
  }

  it("serves one manifest under both filenames", () => {
    const json = readFileSync(new URL("../site/manifest.json", import.meta.url));
    const webmanifest = readFileSync(new URL("../site/manifest.webmanifest", import.meta.url));
    expect(Buffer.compare(json, webmanifest)).toBe(0);
  });
});
