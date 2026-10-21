import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { publicFieldsToTrim, shapePublicBookingFields, shapePublicPatch } from "../workers/schedi-email-worker/src/tenant-private.js";

describe("public tenant shaping", () => {
  it("keeps the booking page plan and drops private billing fields", () => {
    const shaped = shapePublicBookingFields({
      id: "bright-cuts",
      name: "Bright Cuts",
      plan: "starter",
      complimentaryPro: true,
      monthlyPrice: 0,
      subscriptionStatus: "paused",
      acceptingBookings: true,
      showPublicAddress: false,
      address: "10 Main St",
      city: "Austin",
      squareMerchantId: "merchant",
      unpaidDigestWeek: "2026-10-12",
      ownerEmail: "owner@example.com",
    });
    expect(shaped.pub.plan).toBe("pro");
    expect(shaped.pub.acceptingBookings).toBe(false);
    expect(shaped.pub.subscriptionStatus).toBeUndefined();
    expect(shaped.pub.address).toBeUndefined();
    expect(shaped.pub.squareMerchantId).toBeUndefined();
    expect(shaped.pub.unpaidDigestWeek).toBeUndefined();
    expect(shaped.pub.ownerEmail).toBeUndefined();
    expect(shaped.pub.complimentaryPro).toBeUndefined();
    expect(shaped.priv.ownerEmail).toBe("owner@example.com");
    expect(shaped.priv.plan).toBe("starter");
    expect(shaped.priv.subscriptionStatus).toBe("paused");
    expect(shaped.priv.unpaidDigestWeek).toBe("2026-10-12");
  });

  it("stores subscriptionStatus privately and sets acceptingBookings", () => {
    const patch = shapePublicPatch({
      subscriptionStatus: "paused",
      squareMerchantId: "merchant",
      showPublicAddress: false,
      address: "10 Main St",
    });
    expect(patch.pub.subscriptionStatus).toBeUndefined();
    expect(patch.pub.acceptingBookings).toBe(false);
    expect(patch.pub.squareMerchantId).toBeUndefined();
    expect(patch.pub.address).toBeUndefined();
    expect(patch.drop).toEqual(expect.arrayContaining(["squareMerchantId", "address", "subscriptionStatus"]));
    expect(patch.priv.subscriptionStatus).toBe("paused");

    const remove = publicFieldsToTrim({
      name: "Bright Cuts",
      subscriptionStatus: "active",
      squareMerchantId: "merchant",
      unpaidDigestWeek: "2026-10-12",
      showPublicAddress: false,
      address: "10 Main St",
      plan: "pro",
    });
    expect(remove).toEqual(expect.arrayContaining(["squareMerchantId", "unpaidDigestWeek", "address", "subscriptionStatus"]));
    expect(remove).not.toContain("plan");
    expect(remove).not.toContain("name");
  });
});

describe("dry-run cleanup script", () => {
  it("exits unless --dry-run is passed and prints removals for a local fixture", () => {
    const script = new URL("../scripts/trim-public-tenant-docs.mjs", import.meta.url);
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    const refused = spawnSync(process.execPath, [script.pathname], { encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--dry-run");

    const dir = mkdtempSync(join(tmpdir(), "schedi-trim-"));
    const fixture = join(dir, "tenants.json");
    writeFileSync(fixture, JSON.stringify({
      id: "bright-cuts",
      name: "Bright Cuts",
      plan: "pro",
      subscriptionStatus: "active",
      squareMerchantId: "merchant",
      unpaidDigestWeek: "2026-10-12",
      showPublicAddress: false,
      address: "10 Main St",
    }));
    const ran = spawnSync(process.execPath, [script.pathname, "--dry-run", "--fixture", fixture], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    const out = JSON.parse(ran.stdout);
    expect(out.dryRun).toBe(true);
    expect(out.network).toBe(false);
    expect(out.plans[0].remove).toEqual(expect.arrayContaining(["squareMerchantId", "unpaidDigestWeek", "address", "subscriptionStatus"]));
    expect(out.plans[0].remove).not.toContain("plan");
  });
});
