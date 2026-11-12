import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleBookingMailPost } from "../workers/schedi-email-worker/src/booking-mail.js";
import {
  invoiceAmountDue,
  invoiceFullyPaid,
  invoicePaypalUrl,
  invoiceRemoteMethods,
  invoiceVenmoUrl,
} from "../workers/schedi-email-worker/src/invoice.js";
const hoisted = vi.hoisted(() => ({
  bookings: [] as Record<string, unknown>[],
}));

vi.mock("../workers/schedi-email-worker/src/rate-limit.js", () => ({
  rateLimitOk: vi.fn(async () => true),
}));
vi.mock("../workers/schedi-email-worker/src/owner-auth.js", () => ({
  readSession: vi.fn(async () => ({ role: "owner", tenantId: "harbor", email: "axel@example.com" })),
}));
vi.mock("../workers/schedi-email-worker/src/private-bookings.js", () => ({
  loadPrivateAppointments: vi.fn(async () => hoisted.bookings),
}));

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const workerIndex = readFileSync(new URL("../workers/schedi-email-worker/src/index.js", import.meta.url), "utf8");
const workerSquare = readFileSync(new URL("../workers/schedi-email-worker/src/square.js", import.meta.url), "utf8");
const workerBookings = readFileSync(new URL("../workers/schedi-email-worker/src/private-bookings.js", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
  const markers = [
    "window." + name + " = async function",
    "window." + name + " = function",
    "function " + name,
  ];
  let start = -1;
  for (const marker of markers) {
    const at = source.indexOf(marker);
    if (at >= 0) {
      start = at;
      break;
    }
  }
  if (start < 0) throw new Error("missing " + name);
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("could not extract " + name);
}

function pageFns(names: string[]) {
  const src = [
    "var SCHEDI_OWNER_SENTINEL = '__schedi_owner__';",
    "var SCHEDI_OWNER_CONTACT_TOKEN = '{{schedi_owner_contact}}';",
    "var SCHEDI_SQUARE_PUBLIC_ENABLED = true;",
    ...names.map((name) => extractFunction(html, name)),
  ].join("\n");
  return new Function(`${src}\nreturn { ${names.join(", ")} };`)() as Record<string, (...args: any[]) => any>;
}

const page = pageFns([
  "esc",
  "isComplimentaryPro",
  "normalizePlan",
  "roundMoney",
  "hasPricedAmount",
  "catalogServicePrice",
  "freePaymentMessage",
  "invoicePriceDollars",
  "invoiceStatusPaid",
  "invoiceDepositOnly",
  "invoiceCollectedDollars",
  "invoiceAmountDue",
  "invoiceFullyPaid",
  "invoiceLooksLikeUrl",
  "invoiceVenmoUrl",
  "invoicePaypalUrl",
  "invoiceCashAppUrl",
  "invoiceZelleUrl",
  "invoiceRemoteMethods",
  "invoiceSendBlock",
  "invoiceCardPayLink",
  "invoiceSquarePayLink",
  "invoiceMethodLabel",
  "invoiceMethodList",
  "invoicePayButtonHtml",
  "invoiceManualPayUrl",
  "confirmEmailPriceLabel",
  "bookingPayCodeForMethod",
  "confirmEmailPaymentInstructions",
  "formatFriendlyLocalDateEmail",
  "formatConfirmEmailCalParts",
  "cardPayEmailBits",
  "squarePayEmailBits",
  "emailRasterSrc",
  "businessReplyTo",
  "ownerContactPhrase",
  "clientEmailDateCardHtml",
  "clientEmailRowsHtml",
  "clientEmailShellHtml",
  "buildInvoiceEmail",
]);

const TOKEN = "a".repeat(24);

function visit(extra: Record<string, unknown> = {}) {
  return {
    id: "BK-INV0001",
    clientName: "Jana",
    clientEmail: "jana@example.com",
    serviceName: "Portrait",
    date: "2026-11-20",
    time: "02:00 PM",
    amount: 180,
    depositAmount: 40,
    depositPaid: true,
    paymentStatus: "DEPOSIT PAID",
    paymentMethod: "venmo",
    payCode: "SCH-23AB",
    manageToken: TOKEN,
    status: "accepted",
    ...extra,
  };
}

function studio(extra: Record<string, unknown> = {}) {
  return {
    id: "harbor",
    slug: "harbor",
    name: "Axel Photography",
    plan: "pro",
    stripeConnectReady: true,
    squareReady: true,
    paymentGateways: { card: true, square: true, venmo: true, zelle: true, cashapp: true, paypal: true, later: true },
    venmoHandle: "axelphoto",
    zelleHandle: "axel@pay.test",
    cashAppTag: "$axelphoto",
    paypalHandle: "axelphoto",
    ownerName: "Axel",
    ownerEmail: "axel@example.com",
    notifications: { replyTo: "axel@example.com" },
    ...extra,
  };
}

describe("send invoice menu", () => {
  it("adds Send invoice to the agenda and appointment kebabs and leaves the client menu alone", () => {
    for (const name of ["schediAgendaVisitHtml", "rosterListActionsHtml", "rosterActionsHtml"]) {
      const fn = extractFunction(html, name);
      expect(fn).toContain("Send invoice");
      expect(fn).toContain("sendAppointmentInvoice");
      expect(fn).toContain("Edit");
      expect(fn).toContain("Reschedule");
      expect(fn).toContain("Cancel");
      expect(fn).toContain("Delete");
    }
    expect(extractFunction(html, "schediAgendaVisitHtml")).toContain("Mark paid");
    expect(extractFunction(html, "schediAgendaVisitHtml")).toContain("Mark unpaid");
    expect(extractFunction(html, "schediAgendaVisitHtml")).toContain("Mark no-show");
    expect(extractFunction(html, "rosterListActionsHtml")).toContain("Mark paid");
    expect(extractFunction(html, "rosterListActionsHtml")).toContain("Mark unpaid");
    expect(html.split("appointment_invoice").length - 1).toBe(1);
    expect(extractFunction(html, "renderClientList")).not.toContain("Send invoice");
    expect(extractFunction(html, "renderClientList")).toContain("Book appointment");
    expect(bookingHtml).not.toContain("Send invoice");
    expect(bookingHtml).not.toContain("buildInvoiceEmail");
    expect(bookingHtml).not.toContain("appointment_invoice");
  });

  it("sends invoice mail only from the explicit owner submit", () => {
    const submit = extractFunction(html, "submitInvoiceSend");
    expect(submit).toContain("appointment_invoice");
    expect(submit).toContain("buildInvoiceEmail");
    expect(submit).toContain("invoiceOpen = true");
    expect(extractFunction(html, "sendAppointmentInvoice")).not.toContain("dispatchTenantMail");
    expect(extractFunction(html, "sendAppointmentInvoice")).toContain("openInvoiceSendModal");
    for (const name of [
      "acceptAppointment",
      "denyAppointment",
      "sendBookingConfirmationEmail",
      "sendQuotedCardLink",
      "handleSaveTenantPayments",
      "handleManualBookingSubmit",
      "buildConfirmationEmail",
    ]) {
      const fn = extractFunction(html, name);
      expect(fn).not.toContain("buildInvoiceEmail");
      expect(fn).not.toContain("appointment_invoice");
      expect(fn).not.toContain("sendAppointmentInvoice");
    }
  });
});

describe("invoice amount and pay methods", () => {
  it("bills the remaining balance and asks when there is no price", () => {
    const tenant = studio();
    const booking = visit();
    expect(page.invoiceAmountDue(tenant, booking)).toBe(140);
    expect(invoiceAmountDue(tenant, booking)).toBe(140);
    expect(page.invoiceFullyPaid(tenant, booking)).toBe(false);
    expect(invoiceFullyPaid(tenant, booking)).toBe(false);
    expect(page.invoiceSendBlock(tenant, booking)).toBe("");

    const full = visit({ paymentStatus: "PAID VIA CARD", paidMethod: "card", depositPaid: false });
    expect(page.invoiceSendBlock(tenant, full)).toBe("This visit is already marked paid.");
    expect(invoiceFullyPaid(tenant, full)).toBe(true);

    const noEmail = visit({ clientEmail: "" });
    expect(page.invoiceSendBlock(tenant, noEmail)).toBe("This appointment has no client email, so the invoice was not sent.");

    const free = studio({ plan: "free", stripeConnectReady: false, squareReady: false, paymentGateways: { later: true } });
    expect(page.invoiceSendBlock(free, visit())).toBe(page.freePaymentMessage(free, "card"));
    expect(page.invoiceRemoteMethods(free)).toEqual([]);
    expect(invoiceRemoteMethods(free)).toEqual([]);

    const starter = studio({
      plan: "starter",
      stripeConnectReady: false,
      paymentGateways: { card: true, square: true, venmo: true, cashapp: true, later: true },
    });
    expect(page.invoiceRemoteMethods(starter)).toEqual(["square", "cashapp", "venmo"]);
    expect(invoiceRemoteMethods(starter)).toEqual(["square", "cashapp", "venmo"]);
    expect(page.invoiceCardPayLink(starter, visit())).toBe("");

    const bare = studio({
      plan: "pro",
      stripeConnectReady: false,
      squareReady: false,
      paymentGateways: { later: true, card: false, venmo: false, zelle: false, cashapp: false, paypal: false, square: false },
      venmoHandle: "",
      zelleHandle: "",
      cashAppTag: "",
      paypalHandle: "",
    });
    expect(page.invoiceSendBlock(bare, visit())).toBe("Turn on a payment method in Payments before sending an invoice.");

    const unpriced = visit({ amount: null, depositAmount: 0, depositPaid: false, paymentStatus: "PAY AT APPOINTMENT" });
    expect(page.invoiceAmountDue(studio({ services: [] }), unpriced)).toBe(null);
    expect(page.invoiceSendBlock(studio(), unpriced)).toBe("");
    expect(page.invoiceAmountDue(studio({ services: [{ name: "Portrait", price: 90 }] }), visit({ amount: "" }))).toBe(50);
  });

  it("keeps the existing card and confirmation pay-link paths", () => {
    const cardLink = extractFunction(html, "bookingCardPayLink");
    expect(cardLink).toContain("stripeConnectReady !== true");
    expect(cardLink).toContain("!== 'card'");
    expect(cardLink).toContain("https://schedi.app/billing/card-pay?");
    expect(cardLink).not.toContain("invoice=1");
    const confirm = extractFunction(html, "buildConfirmationEmail");
    expect(confirm).toContain("confirmEmailPaymentInstructions(tenant, booking)");
    expect(confirm).toContain("cardPayEmailBits(bookingCardPayLink(tenant, booking))");
    expect(confirm).toContain("squarePayEmailBits(bookingSquarePayLink(tenant, booking))");
    expect(extractFunction(html, "sendQuotedCardLink")).toContain("action: 'send_card_link'");
    expect(extractFunction(html, "handleSaveTenantPayments")).toContain("Free plan only allows pay at the appointment. Payment collection was not saved.");
    const checkout = workerIndex.slice(workerIndex.indexOf("async function handleBookingCheckout"), workerIndex.indexOf("const CONNECT_PUBLIC_CHECKOUT"));
    expect(checkout).toContain("if (data.invoice === true) return invoiceCardCheckout");
    expect(checkout).toContain("if (method !== 'card' && payStatus.indexOf('CARD') === -1)");
    expect(checkout).toContain("return json({ ok: false, error: 'not_card_booking' }, 400, origin);");
    expect(workerSquare).toContain("error: 'not_square_booking'");
    expect(workerBookings).toContain("delete booking.invoiceOpen");
  });
});

describe("invoice email", () => {
  it("uses the confirmation shell, the amount due, every ready pay method, and an optional note", () => {
    const tenant = studio();
    const booking = visit();
    const withNote = page.buildInvoiceEmail(tenant, booking, { note: "See you Thursday, Jana." });
    expect(withNote.subject).toBe("Invoice \u2014 Axel Photography");
    expect(withNote.html).toContain('bgcolor="#059669"');
    expect(withNote.html).toContain("font-family:Arial,Helvetica,sans-serif");
    expect(withNote.html).toContain("Invoice");
    expect(withNote.html).toContain("Portrait");
    expect(withNote.html).toContain("02:00 PM");
    expect(withNote.html).toContain("Amount due");
    expect(withNote.html).toContain("$140");
    expect(withNote.html).toContain("Already paid");
    expect(withNote.html).toContain("$40");
    expect(withNote.html).toContain("See you Thursday, Jana.");
    expect(withNote.html).toContain("Pay by card");
    expect(withNote.html).toContain("https://schedi.app/billing/card-pay?");
    expect(withNote.html).toContain("invoice=1");
    expect(withNote.html).toContain("Pay with Square");
    expect(withNote.html).toContain("https://schedi.app/api/square/pay?");
    expect(withNote.text).toContain("axelphoto");
    expect(withNote.text).toContain("axel@pay.test");
    expect(withNote.text).toContain("Cash App");
    expect(withNote.text).toContain("PayPal");
    expect(withNote.text).toContain("SCH-23AB");
    expect(withNote.html).toContain("https://venmo.com/u/axelphoto");
    expect(withNote.html).toContain("https://www.paypal.me/axelphoto");
    expect(page.invoiceVenmoUrl("axelphoto", "")).toBe(invoiceVenmoUrl("axelphoto", ""));
    expect(page.invoicePaypalUrl("axelphoto", "")).toBe(invoicePaypalUrl("axelphoto", ""));

    const plain = page.buildInvoiceEmail(tenant, booking, { note: "" });
    expect(plain.html).not.toContain("See you Thursday");
    expect(plain.text).not.toContain("Note from");
    expect(page.buildInvoiceEmail(tenant, visit({ amount: 0, depositAmount: 0, depositPaid: false, paymentStatus: "PAY AT APPOINTMENT" }), {})).toBe(null);
  });
});

describe("invoice mail is owner initiated", () => {
  const sendResend = vi.fn(async () => ({ ok: true, id: "mail_invoice" }));

  function deps(tenant: Record<string, unknown>) {
    return {
      json: (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
      isAllowedOrigin: () => true,
      getTenantById: async () => tenant,
      firebaseAnonymousToken: async () => "token",
      sendResend,
      sendBookingConfirmationSms: async () => ({ ok: true }),
      ownerNotifyEnabledForTenant: () => false,
      escapeHtml: (value: unknown) => String(value ?? ""),
      safeTenantId: (value: unknown) => (/^[A-Za-z0-9_-]{1,80}$/.test(String(value || "").trim()) ? String(value).trim() : ""),
      sleep: async () => {},
    };
  }

  async function post(body: Record<string, unknown>, tenant: Record<string, unknown>) {
    const request = new Request("https://schedi.app/api/send-booking-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleBookingMailPost(request, { AUTH_KV: null }, "https://schedi.app", deps(tenant));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("rejects a client token, a paid visit, Free, and a business with no remote method", async () => {
    const tenant = studio();
    const booking = visit();
    hoisted.bookings = [booking];
    const mail = page.buildInvoiceEmail(tenant, booking, { note: "See you Thursday, Jana." });
    sendResend.mockClear();
    const ok = await post({
      tenantId: "harbor",
      bookingId: booking.id,
      session: "owner-session-token",
      type: "appointment_invoice",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }, tenant);
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(sendResend).toHaveBeenCalledTimes(1);
    const sent = sendResend.mock.calls[0][1] as { to: string; subject: string; html: string };
    expect(sent.to).toBe("jana@example.com");
    expect(sent.subject).toBe("Invoice \u2014 Axel Photography");
    expect(sent.html).toContain("See you Thursday, Jana.");

    const client = await post({
      tenantId: "harbor",
      bookingId: booking.id,
      manageToken: TOKEN,
      type: "appointment_invoice",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }, tenant);
    expect(client.status).toBe(401);
    expect(client.body.error).toBe("session_required");

    hoisted.bookings = [visit({ paymentStatus: "PAID", depositPaid: false })];
    const paid = await post({
      tenantId: "harbor",
      bookingId: booking.id,
      session: "owner-session-token",
      type: "appointment_invoice",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }, tenant);
    expect(paid.status).toBe(409);
    expect(paid.body.error).toBe("already_paid");

    hoisted.bookings = [booking];
    const free = await post({
      tenantId: "harbor",
      bookingId: booking.id,
      session: "owner-session-token",
      type: "appointment_invoice",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }, studio({ plan: "free" }));
    expect(free.status).toBe(403);
    expect(free.body.error).toBe("free_plan");

    hoisted.bookings = [booking];
    const none = await post({
      tenantId: "harbor",
      bookingId: booking.id,
      session: "owner-session-token",
      type: "appointment_invoice",
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    }, studio({
      plan: "starter",
      stripeConnectReady: false,
      squareReady: false,
      paymentGateways: { later: true },
      venmoHandle: "",
      zelleHandle: "",
      cashAppTag: "",
      paypalHandle: "",
    }));
    expect(none.status).toBe(400);
    expect(none.body.error).toBe("no_payment_method");
    expect(sendResend).toHaveBeenCalledTimes(1);
  });
});

describe("invoice flag storage", () => {
  it("keeps invoiceOpen only when the owner saved true, and public create clears it", async () => {
    const mod = await vi.importActual<typeof import("../workers/schedi-email-worker/src/private-bookings.js")>(
      "../workers/schedi-email-worker/src/private-bookings.js",
    );
    const sanitize = mod.sanitizeBooking as (raw: Record<string, unknown>, tenantId: string) => { invoiceOpen?: boolean };
    expect(sanitize({ id: "BK-INV0001", invoiceOpen: true, clientName: "Jana" }, "harbor").invoiceOpen).toBe(true);
    expect(sanitize({ id: "BK-INV0001", invoiceOpen: false }, "harbor").invoiceOpen).toBeUndefined();
    expect(sanitize({ id: "BK-INV0001", invoiceOpen: "true" }, "harbor").invoiceOpen).toBeUndefined();
    expect(workerBookings).toContain("delete booking.invoiceOpen");
    expect(workerBookings).toContain("if (prev && prev.invoiceOpen === true) booking.invoiceOpen = true");
  });
});
