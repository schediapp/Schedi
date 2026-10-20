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
  "site/assets/help-videos/client-booking-demo.mp4": "8471285ba2775e12a774c14823bc295aeb1e068eb215d980ef093fed19ed4981",
  "site/assets/help-videos/owner-01-create-your-page.mp4": "be928cd76cb933bb3cee75d8942f6ca1c6e6ce77da7cfe1fe181f632555ccad3",
  "site/assets/help-videos/owner-02-add-services.mp4": "29a8bb11bd37bfeef5cdb16337ef872655f92cf8eb444484a1e950e41a8b0005",
  "site/assets/help-videos/owner-03-set-hours.mp4": "a8ccc85729a860fee4a9069066de80794a335392a6d30d0e6ed444ddd11da130",
  "site/assets/help-videos/owner-04-payment-options.mp4": "8f46bbd7272989701cecb63903d168ba6198de98f74ea1401382ae5f9dede646",
  "site/assets/help-videos/owner-05-share-booking-link.mp4": "493439ffd56ed197362645ee8ab6764627ad43c07e46763b1be7e839d86134ba",
  "site/assets/help-videos/owner-06-accept-booking-request.mp4": "7b1d0e7eff6379e77e08a79ab7b9088b1d7a32dc73118c702ae88fa9b1d48bcd",
  "site/assets/help-videos/owner-07-appointments-report.mp4": "8f851bad1ca568534359f92091cdf46cc4572741f1f81effec79c5623d462c83",
  "site/assets/help-videos/owner-08-add-manual-appointment.mp4": "78d7459a2265b9d2e519a26ff7d9f1d5f6e20467a1a9975c0faa9c2643e3d5db",
  "site/assets/help-videos/owner-09-mark-paid.mp4": "15279165ddffbd240596404c594c59ab1fdfcffceea2ad3c05a05fefdaf3fc12",
  "site/assets/help-videos/owner-10-reschedule.mp4": "9f48252bf866480db30148b5cac5c51e73c5f5da6761b8f84bd650b2d7ded5d9",
  "site/assets/help-videos/owner-11-cancel-appointment.mp4": "276968d5c96106d16f937808831c7fac0bf8ec5c39e670ce169a02f7bdd2b266",
  "site/assets/help-videos/owner-12-special-hours.mp4": "a3f2b171f5334c653a590cc2f7d504d3272068fe9900bf0df71e4cbb1d17f503",
  "site/assets/help-videos/owner-13-date-blocks.mp4": "1b641d59849c9a94a2e9f00c454d3f0563c3863d42eb321465a09f904f6387a0",
  "site/assets/help-videos/owner-14-email-confirmations.mp4": "f1f0e2c87230340d715576f804dce7e3b568868dbd2a1e03804533d39a6480d6",
  "site/assets/help-videos/owner-15-recurring-visits-pro.mp4": "308526fe939fe1fdf8e55f902b12cf9c0fadabe9d8fffcc6a696aee9d36b9d1e",
  "site/assets/help-videos/owner-16-clients.mp4": "23019ae5f3d9074f7586917c384a3987069188545a1799f028a6d31323bb4ef4",
  "site/assets/help-videos/owner-17-import-clients-csv.mp4": "281a51c5af921f05c980f55f5c766b79e1271cb77b5426de36909856814425e1",
  "site/assets/help-videos/owner-18-compare-plans.mp4": "ce4a663612069ab0ec3b197534237059b163bd4b14a8f656dc1d0275e42bc6e9",
  "site/assets/help-videos/owner-19-roster-week-month.mp4": "e849ffd4bbb96824a4d096d3a2f22b53b61589473a603ff9e50d2bf2c5216544",
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
