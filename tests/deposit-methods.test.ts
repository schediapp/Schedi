import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensurePayCodes } from "../workers/schedi-email-worker/src/private-bookings.js";
import { buildOwnerNotifyEmail } from "../workers/schedi-email-worker/src/owner-notify.js";
import { applyOwnerEntitlementLock } from "../workers/schedi-email-worker/src/entitlements.js";
import { hqLoginDocument } from "../worker/public-shell";
import {
  SCHEDI_SQUARE_PUBLIC_ENABLED,
  depositMethodMap,
  methodAcceptsDeposit,
  ownerInPersonMethod,
  squareClientBookingError,
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
  it("stays off even when a business has Square checked", () => {
    expect(SCHEDI_SQUARE_PUBLIC_ENABLED).toBe(false);
    expect(squareOfferedToClients({ paymentGateways: { square: true } })).toBe(false);
    expect(squareClientBookingError({ paymentMethod: "square" })).toBe("square_unavailable");
    expect(squareClientBookingError({ paymentMethod: "cashapp" })).toBe("");
  });

  it("drops Square on an owner save while the kill switch is off", () => {
    const locked = applyOwnerEntitlementLock(
      { paymentGateways: { card: true, square: true, later: true } },
      { plan: "pro", paymentGateways: { card: true, later: true } },
      {},
    );
    expect(locked.pub.paymentGateways.square).toBe(false);
    expect(locked.ignored).toContain("paymentGateways.square");
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
    expect(html).toContain("var SCHEDI_SQUARE_PUBLIC_ENABLED = false;");
    expect(html).toContain("function publicSquareOffered()");
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
