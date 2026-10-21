import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { projectPublicBooking } from "../worker/booking-document";
import {
  PHI_ACK_VERSION,
  PHI_ACK_WORDING,
  resolvePhiAcknowledgment,
} from "../workers/schedi-email-worker/src/phi-ack.js";
import {
  planLocalIdleDefault,
  planOwnerIdleDefault,
  summarizeOwnerIdlePlans,
} from "../workers/schedi-email-worker/src/owner-idle.js";
import { applyOwnerIdleOnSave } from "../workers/schedi-email-worker/src/profile-store.js";
import { planTenantPrivateMove, shapePublicPatch } from "../workers/schedi-email-worker/src/tenant-private.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hqHtml = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const roadmap = readFileSync(new URL("../ROADMAP.md", import.meta.url), "utf8");

describe("medical PHI acknowledgment", () => {
  it("requires a checked acknowledgment and stores who, when, and the wording version", () => {
    const missing = resolvePhiAcknowledgment({
      industry: "Medical",
      accepted: false,
      explicit: true,
      existing: null,
      who: "owner@example.com",
      now: Date.parse("2026-10-21T12:00:00.000Z"),
    });
    expect(missing.ok).toBe(false);
    expect(missing.error).toBe("phi_ack_required");

    const stamped = resolvePhiAcknowledgment({
      industry: "healthcare",
      accepted: true,
      explicit: true,
      existing: null,
      who: "owner@example.com",
      now: Date.parse("2026-10-21T12:00:00.000Z"),
    });
    expect(stamped.ok).toBe(true);
    expect(stamped.phiAcknowledgment).toEqual({
      who: "owner@example.com",
      at: "2026-10-21T12:00:00.000Z",
      version: PHI_ACK_VERSION,
    });

    const kept = resolvePhiAcknowledgment({
      industry: "Medical / Healthcare",
      accepted: false,
      explicit: false,
      existing: stamped.phiAcknowledgment,
      who: "owner@example.com",
    });
    expect(kept.ok).toBe(true);
    expect(kept.phiAcknowledgment).toEqual(stamped.phiAcknowledgment);

    const other = resolvePhiAcknowledgment({
      industry: "Barbershop",
      accepted: false,
      explicit: true,
      existing: null,
      who: "owner@example.com",
    });
    expect(other.ok).toBe(true);
    expect(other.phiAcknowledgment).toBeUndefined();
    expect(PHI_ACK_WORDING).toContain("will not collect health information");
  });

  it("shows the checkbox on signup, the portal, and HQ", () => {
    for (const html of [indexHtml, hqHtml]) {
      expect(html).toContain('for="signupPhiAck"');
      expect(html).toContain('id="signupPhiAck"');
      expect(html).toContain('for="tenantPhiAck"');
      expect(html).toContain('id="tenantPhiAck"');
      expect(html).toContain("schediRequirePhiAck");
    }
    expect(hqHtml).toContain('for="provPhiAck"');
    expect(hqHtml).toContain('id="provPhiAck"');
    expect(hqHtml).toContain('for="editPhiAck"');
    expect(hqHtml).toContain('id="editPhiAck"');
    expect(hqHtml).toContain("ownerIdleTimeoutMin: 30");
  });
});

describe("owner auto log-off default", () => {
  it("moves Off and missing values to 30 and leaves chosen values", () => {
    const rows = [
      {},
      { ownerIdleTimeoutMin: 0 },
      { ownerIdleTimeoutMin: "off" },
      { ownerIdleTimeoutMin: "" },
      { ownerIdleTimeoutMin: null },
      { ownerIdleTimeoutMin: 15 },
      { ownerIdleTimeoutMin: 30 },
      { ownerIdleTimeoutMin: "60" },
      { ownerIdleTimeoutMin: 0, ownerIdleDefaultApplied: true },
      { ownerIdleTimeoutMin: 15, ownerIdleDefaultApplied: true },
    ];
    const plans = rows.map((row) => planOwnerIdleDefault(row));
    expect(plans.map((plan) => plan.action)).toEqual([
      "set-default",
      "set-default",
      "set-default",
      "set-default",
      "set-default",
      "keep",
      "keep",
      "keep",
      "skip",
      "skip",
    ]);
    expect(plans[0].patch).toEqual({ ownerIdleTimeoutMin: 30, ownerIdleDefaultApplied: true });
    expect(plans[5].patch).toEqual({ ownerIdleDefaultApplied: true });
    expect(plans[5].minutes).toBe(15);
    expect(plans[8].patch).toBeNull();
    expect(summarizeOwnerIdlePlans(plans)).toEqual({ setTo30: 5, leftChosen: 3, alreadyApplied: 2 });

    const again = rows.map((row) => {
      const plan = planOwnerIdleDefault(row);
      return planOwnerIdleDefault(Object.assign({}, row, plan.patch || { ownerIdleDefaultApplied: true }));
    });
    expect(again.every((plan) => plan.action === "skip")).toBe(true);
    expect(summarizeOwnerIdlePlans(again)).toEqual({ setTo30: 0, leftChosen: 0, alreadyApplied: rows.length });
  });

  it("keeps a later Off after the default has been applied", () => {
    const first = applyOwnerIdleOnSave({}, {});
    expect(first.ownerIdleTimeoutMin).toBe(30);
    expect(first.ownerIdleDefaultApplied).toBe(true);
    const chosen = applyOwnerIdleOnSave({ ownerIdleTimeoutMin: 15 }, {});
    expect(chosen.ownerIdleTimeoutMin).toBe(15);
    const off = applyOwnerIdleOnSave({ ownerIdleTimeoutMin: 0 }, first);
    expect(off.ownerIdleTimeoutMin).toBe(0);
    expect(off.ownerIdleDefaultApplied).toBe(true);
    const localOff = planLocalIdleDefault("0", true);
    expect(localOff.minutes).toBe(0);
    expect(localOff.migrated).toBe(false);
    expect(planLocalIdleDefault("off", false).minutes).toBe(30);
    expect(planLocalIdleDefault("15", false)).toMatchObject({ minutes: 15, keptChoice: true, migrated: true });
  });

  it("dry-runs a local fixture and refuses to write", () => {
    const script = new URL("../scripts/migrate-owner-idle.mjs", import.meta.url);
    const source = readFileSync(script, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/method:\s*['"]PATCH['"]/);
    expect(source).not.toMatch(/method:\s*['"]DELETE['"]/);

    const refused = spawnSync(process.execPath, [script.pathname], { encoding: "utf8" });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("--dry-run");

    const apply = spawnSync(process.execPath, [script.pathname, "--apply"], { encoding: "utf8" });
    expect(apply.status).toBe(1);
    expect(apply.stderr).toContain("does not write");

    const dir = mkdtempSync(join(tmpdir(), "schedi-idle-"));
    const fixture = join(dir, "tenants.json");
    writeFileSync(fixture, JSON.stringify([
      { id: "off-biz", ownerIdleTimeoutMin: "off" },
      { id: "missing-biz" },
      { id: "quarter", ownerIdleTimeoutMin: 15 },
      { id: "hour", ownerIdleTimeoutMin: 60 },
      { id: "later-off", ownerIdleTimeoutMin: 0, ownerIdleDefaultApplied: true },
    ]));
    const ran = spawnSync(process.execPath, [script.pathname, "--dry-run", "--fixture", fixture], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    const out = JSON.parse(ran.stdout);
    expect(out.dryRun).toBe(true);
    expect(out.network).toBe(false);
    expect(out.counts).toEqual({ setTo30: 2, leftChosen: 2, alreadyApplied: 1 });
    expect(out.plans.find((row: { id: string }) => row.id === "quarter").patch).toEqual({ ownerIdleDefaultApplied: true });
    expect(out.plans.find((row: { id: string }) => row.id === "later-off").patch).toBeNull();
  });
});

describe("private signup and connect status", () => {
  it("copies missing keys, leaves values already stored, and keeps stripeConnectReady public", () => {
    const move = planTenantPrivateMove({
      id: "bright-cuts",
      name: "Bright Cuts",
      plan: "pro",
      signupStartedAt: "2026-10-01T00:00:00.000Z",
      stripeConnectStatus: "in_progress",
      stripeConnectReady: false,
    });
    expect(move.copy.signupStartedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(move.copy.stripeConnectStatus).toBe("in_progress");
    expect(move.remove).toContain("signupStartedAt");
    expect(move.remove).toContain("stripeConnectStatus");
    expect(move.remove).not.toContain("stripeConnectReady");
    expect(move.remove).not.toContain("plan");

    const present = planTenantPrivateMove({
      id: "bright-cuts",
      signupStartedAt: "2026-10-02T00:00:00.000Z",
      stripeConnectStatus: "ready",
      stripeConnectReady: true,
    }, {
      signupStartedAt: "",
      stripeConnectStatus: "in_progress",
    });
    expect(present.copy.signupStartedAt).toBeUndefined();
    expect(present.copy.stripeConnectStatus).toBeUndefined();
    expect(present.kept).toEqual(expect.arrayContaining(["signupStartedAt", "stripeConnectStatus"]));
    expect(present.remove).toEqual(expect.arrayContaining(["signupStartedAt", "stripeConnectStatus"]));

    const patch = shapePublicPatch({ stripeConnectReady: true, stripeConnectStatus: "ready" });
    expect(patch.pub.stripeConnectReady).toBe(true);
    expect(patch.pub.stripeConnectStatus).toBeUndefined();
    expect(patch.priv.stripeConnectStatus).toBe("ready");
    expect(patch.drop).toContain("stripeConnectStatus");

    const booking = projectPublicBooking({
      name: "Bright Cuts",
      stripeConnectReady: true,
      stripeConnectStatus: "ready",
      signupStartedAt: "2026-10-01T00:00:00.000Z",
      phiAcknowledgment: { who: "a@b.co", at: "2026-10-21T00:00:00.000Z", version: PHI_ACK_VERSION },
      ownerIdleTimeoutMin: 30,
      ownerIdleDefaultApplied: true,
    });
    expect(booking.stripeConnectReady).toBe(true);
    expect(booking.stripeConnectStatus).toBeUndefined();
    expect(booking.signupStartedAt).toBeUndefined();
    expect(booking.phiAcknowledgment).toBeUndefined();
    expect(booking.ownerIdleTimeoutMin).toBeUndefined();
    expect(booking.name).toBe("Bright Cuts");
  });
});

describe("neutral tenant login and roadmap", () => {
  it("does not say the password was accepted", () => {
    const sentence = "We couldn\\'t open a business portal for this account. Contact support.";
    expect(indexHtml).toContain(sentence);
    expect(hqHtml).toContain(sentence);
    expect(indexHtml).not.toContain("Your password was accepted");
    expect(hqHtml).not.toContain("Your password was accepted");
  });

  it("records optional owner two-step login", () => {
    expect(roadmap).toContain("Optional owner two-step login (2FA)");
  });
});
