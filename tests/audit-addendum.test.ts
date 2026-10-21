import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { planTenantPrivateMove, runTenantPrivateMove } from "../workers/schedi-email-worker/src/tenant-private.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const rules = readFileSync(new URL("../firestore.rules", import.meta.url), "utf8");

describe("private tenant migration plan", () => {
  it("copies billing fields, keeps the public plan tier, and deletes status only after verify", async () => {
    const move = planTenantPrivateMove({
      id: "bright-cuts",
      name: "Bright Cuts",
      plan: "starter",
      complimentaryPro: true,
      subscriptionStatus: "paused",
      ownerEmail: "owner@example.com",
      monthlyPrice: 0,
    });
    expect(move.copy.subscriptionStatus).toBe("paused");
    expect(move.copy.plan).toBe("starter");
    expect(move.copy.ownerEmail).toBe("owner@example.com");
    expect(move.remove).toContain("subscriptionStatus");
    expect(move.remove).toContain("ownerEmail");
    expect(move.remove).not.toContain("plan");
    expect(move.publicPatch.acceptingBookings).toBe(false);
    expect(move.publicPatch.plan).toBe("pro");

    const calls: string[] = [];
    const failed = await runTenantPrivateMove("bright-cuts", move, {
      copy: async () => { calls.push("copy"); },
      read: async () => ({ plan: "free" }),
      publicPatch: async () => { calls.push("publicPatch"); },
      remove: async () => { calls.push("delete"); },
    });
    expect(failed.ok).toBe(false);
    expect(failed.steps).toEqual(["copy", "verify"]);
    expect(calls).toEqual(["copy"]);

    calls.length = 0;
    const stored: Record<string, unknown> = {};
    const applied = await runTenantPrivateMove("bright-cuts", move, {
      copy: async (_id: string, priv: Record<string, unknown>) => {
        calls.push("copy");
        Object.assign(stored, priv);
      },
      read: async () => stored,
      publicPatch: async () => { calls.push("publicPatch"); },
      remove: async () => { calls.push("delete"); },
    });
    expect(applied.ok).toBe(true);
    expect(applied.steps).toEqual(["copy", "verify", "publicPatch", "delete"]);
    expect(calls).toEqual(["copy", "publicPatch", "delete"]);
  });

  it("copies only keys the private doc is missing and still verifies before delete", async () => {
    const move = planTenantPrivateMove({
      id: "bright-cuts",
      name: "Bright Cuts",
      plan: "starter",
      subscriptionStatus: "paused",
      ownerEmail: "public@example.com",
      notifications: { replyTo: "desk@example.com", emailConfirmations: true },
    }, {
      plan: "pro",
      subscriptionStatus: "active",
      ownerEmail: "",
      notificationsReplyTo: null,
    });
    expect(move.copy.plan).toBeUndefined();
    expect(move.copy.subscriptionStatus).toBeUndefined();
    expect(move.copy.ownerEmail).toBeUndefined();
    expect(move.copy.notificationsReplyTo).toBeUndefined();
    expect(move.kept).toEqual(expect.arrayContaining(["plan", "subscriptionStatus", "ownerEmail", "notificationsReplyTo"]));
    expect(move.remove).toContain("subscriptionStatus");
    expect(move.remove).toContain("ownerEmail");
    expect(move.remove).toContain("notifications.replyTo");
    expect(move.remove).not.toContain("plan");
    expect(move.publicPatch.acceptingBookings).toBe(true);

    const calls: string[] = [];
    const refused = await runTenantPrivateMove("bright-cuts", { copy: {}, remove: ["subscriptionStatus", "notifications.replyTo"], publicPatch: {} }, {
      copy: async () => { calls.push("copy"); },
      read: async () => ({ subscriptionStatus: "active" }),
      publicPatch: async () => { calls.push("publicPatch"); },
      remove: async () => { calls.push("delete"); },
    });
    expect(refused.ok).toBe(false);
    expect(refused.steps).toEqual(["verify"]);
    expect(refused.missing).toEqual(["notificationsReplyTo"]);
    expect(calls).toEqual([]);

    calls.length = 0;
    const deleted = await runTenantPrivateMove("bright-cuts", move, {
      copy: async () => { calls.push("copy"); },
      read: async () => ({
        plan: "pro",
        subscriptionStatus: "active",
        ownerEmail: "",
        notificationsReplyTo: null,
      }),
      publicPatch: async () => { calls.push("publicPatch"); },
      remove: async () => { calls.push("delete"); },
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.steps).toEqual(["verify", "publicPatch", "delete"]);
    expect(calls).toEqual(["publicPatch", "delete"]);
  });

  it("dry-runs a local fixture and refuses to write", () => {
    const script = new URL("../scripts/migrate-tenant-private.mjs", import.meta.url);
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

    const dir = mkdtempSync(join(tmpdir(), "schedi-private-"));
    const fixture = join(dir, "tenants.json");
    writeFileSync(fixture, JSON.stringify({
      id: "bright-cuts",
      name: "Bright Cuts",
      plan: "pro",
      subscriptionStatus: "active",
      ownerEmail: "owner@example.com",
    }));
    const ran = spawnSync(process.execPath, [script.pathname, "--dry-run", "--fixture", fixture], { encoding: "utf8" });
    expect(ran.status).toBe(0);
    const out = JSON.parse(ran.stdout);
    expect(out.dryRun).toBe(true);
    expect(out.network).toBe(false);
    expect(out.order).toEqual(["copy", "verify", "publicPatch", "delete"]);
    expect(out.plans[0].copy).toEqual(expect.arrayContaining(["plan", "subscriptionStatus", "ownerEmail"]));
    expect(out.plans[0].remove).toContain("subscriptionStatus");
    expect(out.plans[0].remove).not.toContain("plan");
    expect(out.plans[0].publicPatch.plan).toBeUndefined();
    expect(out.plans[0].publicPatch.acceptingBookings).toBe(true);
  });
});

describe("audit addendum markup", () => {
  it("keeps private tenant reads denied and leaves booking fields public", () => {
    expect(rules).toContain("allow get, list: if true");
    expect(rules).toContain("allow create, update, delete: if false");
    expect(rules).toMatch(/private\/data\/tenants[\s\S]*allow read, write: if false/);
    expect(rules).toContain("subscriptionStatus");
  });

  it("shows a persistent tenant login alert and a distinct missing-business message", () => {
    expect(indexHtml).toContain('id="tenantLoginAlert" role="alert"');
    expect(indexHtml).toContain("Your password was accepted, but this business is not on this page yet. Refresh and try again.");
    expect(indexHtml).toContain("function tenantLoginFail");
    expect(indexHtml).toContain("showToast(message, 'error')");
  });

  it("labels the booking name, phone, and date picker", () => {
    expect(indexHtml).toContain('<label class="block text-xs text-slate-300 mb-1" for="pubClientName">Full Name *</label>');
    expect(indexHtml).toContain('id="pubClientName" required autocomplete="name"');
    expect(indexHtml).toContain('<label class="block text-xs text-slate-300 mb-1" for="pubClientPhone">Phone Number *</label>');
    expect(indexHtml).toContain('id="pubClientPhone" required autocomplete="tel"');
    expect(indexHtml).toContain('for="pubClientEmail"');
    expect(indexHtml).toContain('oninput="noteDuplicatedEmailTld(this.value)"');
    expect(indexHtml).toContain('id="calendarPickerInput"');
    expect(indexHtml).toContain('aria-label="Choose a date"');
    expect(indexHtml).toContain('for="signupBusinessName"');
    expect(indexHtml).toContain('for="tenantCashAppTagInput"');
    expect(indexHtml).toContain('for="tenantZelleHandleInput"');
    expect(indexHtml).toContain('for="tenantZelleLinkInput"');
    expect(indexHtml).toContain('for="tenantVenmoHandleInput"');
    expect(indexHtml).toContain('for="tenantVenmoLinkInput"');
    expect(indexHtml).toContain('for="tenantPaypalHandleInput"');
    expect(indexHtml).toContain('for="tenantPaypalLinkInput"');
    const hq = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
    expect(hq).toContain('for="pubClientName"');
    expect(hq).toContain('for="pubClientPhone"');
    expect(hq).toContain('for="tenantCashAppTagInput"');
    expect(hq).toContain('for="provCashApp"');
    expect(hq).toContain('for="editCashAppTag"');
    expect(hq).toContain('for="agencyPaypalId"');
    const booking = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
    expect(booking).toContain('for="pubClientName"');
    expect(booking).toContain('for="pubClientPhone"');
    expect(booking).toContain('for="pubClientEmail"');
    expect(booking).toContain('oninput="noteDuplicatedEmailTld(this.value)"');
  });

  it("escapes the booking calendar label and numeric-guards service actions", () => {
    expect(indexHtml).toContain('<span class="cal-day-label">\\${escHtml(label)}</span>');
    expect(indexHtml).not.toContain("openEditServiceModal(${s.id})");
    expect(indexHtml).not.toContain("deleteService(${s.id})");
    expect(indexHtml).toContain("openEditServiceModal(${Number(s.id) || 0})");
    expect(indexHtml).toContain("deleteService(${Number(s.id) || 0})");
  });
});
