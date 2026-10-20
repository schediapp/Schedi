import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensurePayCodes } from "../workers/schedi-email-worker/src/private-bookings.js";
import { buildOwnerNotifyEmail } from "../workers/schedi-email-worker/src/owner-notify.js";
import { applyOwnerEntitlementLock, preserveServerOwnedConnectFields } from "../workers/schedi-email-worker/src/entitlements.js";
import { sanitizeProfile } from "../workers/schedi-email-worker/src/profile-store.js";
import { hqLoginDocument } from "../worker/public-shell";
import {
  SCHEDI_SQUARE_PUBLIC_ENABLED,
  activeCardRail,
  bothCardRailsReady,
  cardProcessorPreference,
  depositMethodMap,
  methodAcceptsDeposit,
  ownerInPersonMethod,
  squareClientBookingError,
  squareMerchantReady,
  squareOfferedToClients,
} from "../workers/schedi-email-worker/src/deposit-methods.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

describe("deposit methods", () => {
  const tenant = {
    paymentGateways: { card: true, cashapp: true, zelle: false, venmo: true, paypal: false, later: true },
    deposit: { enabled: true, type: "fixed", amount: 25 },
  };

  it("defaults deposit methods to the gateways the owner already turned on", () => {
    expect(depositMethodMap(tenant)).toEqual({
      card: true,
      cashapp: true,
      zelle: false,
      venmo: true,
      paypal: false,
    });
    expect(methodAcceptsDeposit(tenant, "cashapp")).toBe(true);
    expect(methodAcceptsDeposit(tenant, "zelle")).toBe(false);
    expect(methodAcceptsDeposit(tenant, "later")).toBe(false);
    expect(methodAcceptsDeposit(tenant, "square")).toBe(false);
  });

  it("keeps an explicit off even when that gateway is enabled", () => {
    const chosen = {
      ...tenant,
      deposit: { ...tenant.deposit, methods: { card: true, cashapp: false, zelle: true, venmo: true, paypal: false } },
    };
    expect(methodAcceptsDeposit(chosen, "cashapp")).toBe(false);
    expect(methodAcceptsDeposit(chosen, "zelle")).toBe(false);
    expect(methodAcceptsDeposit(chosen, "card")).toBe(true);
  });

  it("maps Pay at Appt to the owner in-person method", () => {
    expect(ownerInPersonMethod("later")).toBe("cash");
    expect(ownerInPersonMethod("Pay at Appt")).toBe("cash");
    expect(ownerInPersonMethod("cashapp")).toBe("cashapp");
  });
});

describe("Square public switch", () => {
  const squareOnly = { plan: "starter", paymentGateways: { square: true }, squareReady: true };
  const both = {
    plan: "pro",
    stripeConnectReady: true,
    squareReady: true,
    paymentGateways: { card: true, square: true },
  };

  it("offers Square only for this business's own connected merchant", () => {
    expect(SCHEDI_SQUARE_PUBLIC_ENABLED).toBe(true);
    expect(squareMerchantReady({ squareReady: true })).toBe(true);
    expect(squareMerchantReady({})).toBe(false);
    expect(squareOfferedToClients(squareOnly)).toBe(true);
    expect(squareOfferedToClients({ ...squareOnly, squareReady: false })).toBe(false);
    expect(squareOfferedToClients({ ...squareOnly, paymentGateways: { square: false } })).toBe(false);
    expect(squareClientBookingError({ paymentMethod: "square" }, { ...squareOnly, squareReady: false })).toBe("square_not_ready");
    expect(squareClientBookingError({ paymentMethod: "square" }, squareOnly)).toBe("");
    expect(squareClientBookingError({ paymentMethod: "cashapp" })).toBe("");
  });

  it("defaults to Stripe when both card rails are ready", () => {
    expect(cardProcessorPreference({})).toBe("stripe");
    expect(cardProcessorPreference({ cardProcessor: "square" })).toBe("square");
    expect(bothCardRailsReady(both)).toBe(true);
    expect(activeCardRail(both)).toBe("stripe");
    expect(squareOfferedToClients(both)).toBe(false);
    expect(squareClientBookingError({ paymentMethod: "square" }, both)).toBe("square_not_offered");
    expect(activeCardRail({ ...both, cardProcessor: "square" })).toBe("square");
    expect(squareOfferedToClients({ ...both, cardProcessor: "square" })).toBe(true);
    expect(squareClientBookingError({ paymentMethod: "square" }, { ...both, cardProcessor: "square" })).toBe("");
    expect(activeCardRail({ plan: "pro", stripeConnectReady: true, paymentGateways: { card: true } })).toBe("stripe");
  });

  it("keeps an owner's Square choice now that Square is on", () => {
    const locked = applyOwnerEntitlementLock(
      { paymentGateways: { card: true, square: true, later: true }, cardProcessor: "square" },
      { plan: "pro", paymentGateways: { card: true, later: true } },
      {},
    );
    expect(locked.pub.paymentGateways.square).toBe(true);
    expect(locked.pub.cardProcessor).toBe("square");
    expect(locked.ignored).not.toContain("paymentGateways.square");
  });

  it("keeps Connect readiness on the stored values when an owner sends new ones", () => {
    const stored = {
      plan: "pro",
      stripeConnectReady: false,
      stripeConnectStatus: "in_progress",
      squareReady: false,
      squareConnectStatus: "not_started",
    };
    const locked = applyOwnerEntitlementLock(
      {
        stripeConnectReady: true,
        stripeConnectStatus: "ready",
        squareReady: true,
        squareConnectStatus: "ready",
        paymentGateways: { card: true },
      },
      stored,
      {},
    );
    expect(locked.pub.stripeConnectReady).toBe(false);
    expect(locked.pub.stripeConnectStatus).toBe("in_progress");
    expect(locked.pub.squareReady).toBe(false);
    expect(locked.pub.squareConnectStatus).toBe("not_started");
    expect(locked.ignored).toEqual([
      "stripeConnectReady",
      "squareReady",
      "stripeConnectStatus",
      "squareConnectStatus",
    ]);
    const agency = preserveServerOwnedConnectFields(
      { name: "Harbor", stripeConnectReady: true, squareConnectStatus: "ready" },
      { stripeConnectReady: false, squareConnectStatus: "in_progress" },
    );
    expect(agency.pub.stripeConnectReady).toBe(false);
    expect(agency.pub.squareConnectStatus).toBe("in_progress");
    expect(agency.pub.name).toBe("Harbor");
    expect(agency.ignored).toEqual(["stripeConnectReady", "squareConnectStatus"]);
    const clean = sanitizeProfile({
      name: "Harbor",
      stripeConnectReady: true,
      squareReady: true,
      stripeConnectStatus: "ready",
      squareConnectStatus: "ready",
    }, "harbor");
    expect(clean.stripeConnectReady).toBeUndefined();
    expect(clean.squareReady).toBeUndefined();
    expect(clean.stripeConnectStatus).toBeUndefined();
    expect(clean.squareConnectStatus).toBeUndefined();
    expect(clean.name).toBe("Harbor");
  });
});

describe("manual deposit payment codes and request email", () => {
  it("keeps a payment code when Cash App still owes a deposit", () => {
    const saved = ensurePayCodes([
      { id: "bk1", paymentMethod: "cashapp", depositAmount: 25, depositPaid: false },
      { id: "bk2", paymentMethod: "card", depositAmount: 25, depositPaid: false },
    ]);
    expect(saved[0].payCode).toMatch(/^SCH-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    expect(saved[1].payCode).toBeUndefined();
  });

  it("puts the deposit, handle, and payment code on the owner request email", () => {
    const mail = buildOwnerNotifyEmail(
      { name: "Harbor Studio", slug: "harbor-demo", cashAppTag: "$HarborStudio" },
      {
        id: "BK-1",
        status: "pending",
        clientName: "Ada",
        serviceName: "Cut",
        date: "2026-10-17",
        time: "10:00 AM",
        paymentMethod: "cashapp",
        paymentOptionLabel: "Cash App",
        payCode: "SCH-2345",
        depositAmount: 25,
        depositPaid: false,
        balanceDue: 40,
      },
    );
    expect(mail.text).toContain("Payment: Cash App");
    expect(mail.text).toContain("Payment code: SCH-2345");
    expect(mail.text).toContain("Deposit: $25.00 (unpaid until you mark it paid)");
    expect(mail.text).toContain("Cash App $HarborStudio");
    expect(mail.text).toContain("Remaining balance: $40.00");
    expect(mail.html).toContain("Cash App $HarborStudio");
  });
});

describe("new booking and HQ designs are the default", () => {
  it("keeps Pay at Appt, hides Square behind both switches, and turns the booking skin on unless classicbook", () => {
    expect(html).toContain(">Pay at Appt</button>");
    expect(html).not.toContain("In person / Cash</button>");
    expect(html).toContain("var SCHEDI_SQUARE_PUBLIC_ENABLED = true;");
    expect(html).not.toContain("var SCHEDI_SQUARE_PUBLIC_ENABLED = false;");
    expect(html).toContain("function publicSquareOffered()");
    expect(html).toContain("tenantData.squareReady === true");
    expect(html).toContain("tenantData.cardProcessor");
    expect(html).toContain('id="tenantCardProcessor"');
    expect(html).toContain("Connect Square");
    expect(html).toContain("Set up Stripe");
    expect(html).toContain("function payAccountStatusLabel(status)");
    expect(html).toContain("return 'Not started'");
    expect(html).toContain("return 'In progress'");
    expect(html).toContain("return 'Ready'");
    expect(html).toContain("stripeStatus !== 'ready'");
    expect(html).toContain("squareStatus !== 'ready'");
    expect(html).toContain("https://schedi.app/api/square/connect");
    expect(html).toContain("https://schedi.app/api/square/pay?t=");
    expect(html).toContain("https://schedi-connect-production.up.railway.app/portal");
    expect(html).toContain("function publicMethodAcceptsDeposit(method)");
    expect(html).toContain("function schediNewBookOn");
    const bookFn = html.slice(html.indexOf("function schediNewBookOn"), html.indexOf("function bookingPaymentState"));
    expect(bookFn).toContain("newbook");
    expect(bookFn).toContain("classicbook");
    expect(bookFn).toContain("return true");
    expect(bookFn).not.toContain("localStorage");
    expect(html).toContain("get('classicbook')");
    expect(html).toContain("document.documentElement.classList.toggle('schedi-newbook', SCHEDI_NEWBOOK === true)");
  });

  it("uses the HQ sign-in theme by default and keeps ?classichq=1 as the hatch", () => {
    const doc = hqLoginDocument();
    expect(doc).toContain("Schedi HQ");
    expect(doc).toContain("html.schedi-light.schedi-newhq");
    expect(doc).toContain("get('newhq')");
    expect(doc).toContain("get('classichq')");
    expect(doc).toContain("var on = true");
    expect(doc).toContain("if (!on) return;");
    expect(doc).not.toContain("schediNewHq");
  });
});
