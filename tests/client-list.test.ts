import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
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

function dashCss(source: string): string {
  const marker = '<style id="schediNewDashStyle">';
  const start = source.indexOf(marker);
  const end = source.indexOf("</style>", start);
  return source.slice(start + marker.length, end);
}

const names = [
  "clientNormEmail",
  "clientPhoneKey",
  "clientTagList",
  "clientCleanText",
  "clientHistoryIso",
  "clientBookingMatches",
  "clientHistoryMinutes",
  "clientHistorySortKey",
  "clientListMethods",
  "clientListMethodLabel",
  "clientListMethodRank",
  "clientListMethodAllowed",
  "clientListDefaultDir",
  "clientListDirLabel",
  "clientVisitMethod",
  "clientIsWalkIn",
  "clientListStats",
  "clientListCompare",
  "clientListArrange",
  "clientListCsv",
  "roundMoney",
  "hasPricedAmount",
  "bookingPaymentState",
  "catalogServicePrice",
  "rosterAmountCollected",
  "inferPaidMethodFromBooking",
  "appointmentPayKind",
  "reportClockMinutes",
  "reportAppointmentStarted",
  "reportIsDeleted",
  "reportIsPending",
  "reportIsDoneStatus",
  "reportIsConfirmedStatus",
  "reportIsCancelled",
  "reportIsDenied",
  "reportCancelledAfterConfirm",
  "appointmentIsNoShow",
  "appointmentCompletionOf",
];

const lib = names.map((name) => extractFunction(html, name)).join("\n");
const api = new Function(`${lib}
  return {
    clientListArrange, clientListStats, clientListCsv, clientListDirLabel, clientListDefaultDir, clientIsWalkIn, clientVisitMethod,
    rosterAmountCollected, appointmentPayKind, appointmentCompletionOf
  };
`)() as {
  clientListArrange: (
    clients: Record<string, unknown>[],
    appointments: Record<string, unknown>[],
    options: Record<string, unknown>,
  ) => Array<{ name: string; stats: Stats }>;
  clientListStats: (client: Record<string, unknown>, appointments: Record<string, unknown>[], options: Record<string, unknown>) => Stats;
  clientListCsv: (rows: Array<{ name?: string; email?: string; phone?: string; notes?: string; stats?: Stats }>) => string;
  clientListDirLabel: (sort: string, dir: string) => string;
  clientListDefaultDir: (sort: string) => string;
  clientIsWalkIn: (client: Record<string, unknown> | null, appointments: Record<string, unknown>[]) => boolean;
  clientVisitMethod: (app: Record<string, unknown>, payKind: (app: Record<string, unknown>) => string) => string;
  rosterAmountCollected: (app: Record<string, unknown>, tenant: { services?: { name: string; price: number | null }[] }) => { net: number; empty: boolean };
  appointmentPayKind: (app: Record<string, unknown>) => string;
  appointmentCompletionOf: (app: Record<string, unknown>, asOf: { date: string; minutes: number }) => string;
};

type Stats = {
  visits: number;
  paid: number;
  paidKnown: boolean;
  method: string;
  methodLabel: string;
  methods: string[];
  methodLabels: string[];
  walkIn: boolean;
  firstVisit: string;
  lastVisit: string;
};

const stubOptions = {
  doneOf: (app: { done?: string }) => app.done || "",
  collectedOf: (app: { money?: { net: number; empty: boolean } }) => app.money || { net: 0, empty: true },
  payKind: (app: { kind?: string }) => app.kind || "unpaid",
};

const ada = { id: "ada", name: "Ada", email: "ada@example.com", phone: "5551111111" };
const bea = { id: "bea", name: "Bea", email: "bea@example.com", phone: "5552222222" };
const cy = { id: "cy", name: "Cy", email: "cy@example.com", phone: "5553333333" };
const dee = { id: "dee", name: 'dee, "quoted"', email: "dee@example.com", phone: "5554444444", notes: "quoted note" };
const eve = { id: "eve", name: "Eve", email: "eve@example.com", phone: "5555555555", walkIn: true };
const clients = [cy, ada, eve, dee, bea];

const appointments = [
  { clientEmail: "ada@example.com", date: "2026-10-02", time: "09:00 AM", done: "done", money: { net: 10, empty: false }, kind: "card" },
  { clientEmail: "bea@example.com", date: "2026-10-01", time: "09:00 AM", done: "done", money: { net: 5, empty: false }, kind: "venmo" },
  { clientEmail: "bea@example.com", date: "2026-10-03", time: "09:00 AM", done: "done", money: { net: 0, empty: true }, kind: "venmo" },
  { clientEmail: "bea@example.com", date: "2026-10-04", time: "09:00 AM", done: "done", money: { net: 0, empty: true }, kind: "unpaid", paymentStatus: "PAY AT APPOINTMENT", status: "accepted", walkIn: true },
  { clientEmail: "cy@example.com", date: "2026-09-01", time: "09:00 AM", done: "done", money: { net: 20, empty: false }, kind: "venmo" },
  { clientEmail: "cy@example.com", date: "2026-09-02", time: "09:00 AM", done: "done", money: { net: 20, empty: false }, kind: "venmo" },
  { clientEmail: "cy@example.com", date: "2026-09-03", time: "09:00 AM", done: "done", money: { net: 0, empty: true }, kind: "unpaid" },
  { clientEmail: "eve@example.com", date: "2026-08-01", time: "09:00 AM", done: "done", money: { net: 0, empty: false }, kind: "cash" },
  { clientEmail: "eve@example.com", date: "2026-08-02", time: "09:00 AM", done: "done", money: { net: 0, empty: false }, kind: "cash" },
  { clientEmail: "bea@example.com", date: "2026-07-01", time: "09:00 AM", done: "", money: { net: 0, empty: true }, kind: "unpaid", status: "denied", paymentStatus: "PAY AT APPOINTMENT" },
];

function namesOf(sort: string, dir: string, extra: Record<string, unknown> = {}) {
  return api.clientListArrange(clients, appointments, { ...stubOptions, sort, dir, ...extra }).map((row) => row.name);
}

describe("client list sorting and totals", () => {
  it("sorts by name, done visits, collected amount, method group, and walk-in", () => {
    expect(namesOf("name", "asc")).toEqual(["Ada", "Bea", "Cy", 'dee, "quoted"', "Eve"]);
    expect(namesOf("name", "desc")).toEqual(["Eve", 'dee, "quoted"', "Cy", "Bea", "Ada"]);
    expect(namesOf("visits", "desc")).toEqual(["Bea", "Cy", "Eve", "Ada", 'dee, "quoted"']);
    expect(namesOf("visits", "asc")).toEqual(['dee, "quoted"', "Ada", "Eve", "Bea", "Cy"]);
    expect(namesOf("paid", "desc")).toEqual(["Cy", "Ada", "Bea", 'dee, "quoted"', "Eve"]);
    expect(namesOf("paid", "asc")).toEqual(['dee, "quoted"', "Eve", "Bea", "Ada", "Cy"]);
    expect(namesOf("method", "asc")).toEqual(["Ada", "Eve", "Bea", "Cy", 'dee, "quoted"']);
    expect(namesOf("method", "desc")).toEqual(["Bea", "Cy", "Eve", "Ada", 'dee, "quoted"']);
    expect(api.clientListDefaultDir("visits")).toBe("desc");
    expect(api.clientListDefaultDir("paid")).toBe("desc");
    expect(api.clientListDefaultDir("method")).toBe("asc");
    expect(api.clientListDefaultDir("name")).toBe("asc");
    expect(namesOf("walkin", "asc")).toEqual(["Bea", "Eve", "Ada", "Cy", 'dee, "quoted"']);
    expect(namesOf("walkin", "desc")).toEqual(["Ada", "Cy", 'dee, "quoted"', "Bea", "Eve"]);
    expect(api.clientListDirLabel("name", "asc")).toBe("A–Z");
    expect(api.clientListDirLabel("paid", "desc")).toBe("High–low");
    expect(api.clientListDirLabel("walkin", "asc")).toBe("Walk-ins first");
    expect(api.clientListDirLabel("walkin", "desc")).toBe("Walk-ins last");
  });

  it("filters walk-ins and the most-used method, and keeps the search", () => {
    expect(namesOf("name", "asc", { walkOnly: true })).toEqual(["Bea", "Eve"]);
    expect(namesOf("name", "asc", { method: "venmo" })).toEqual(["Bea", "Cy"]);
    expect(namesOf("paid", "desc", { method: "venmo", walkOnly: true })).toEqual(["Bea"]);
    expect(namesOf("name", "asc", { query: "quoted" })).toEqual(['dee, "quoted"']);
    expect(namesOf("name", "asc", { query: "555222" })).toEqual(["Bea"]);
  });

  it("counts done visits, net paid, methods, and walk-ins from bookings", () => {
    const beaStats = api.clientListStats(bea, appointments, stubOptions);
    expect(beaStats.visits).toBe(3);
    expect(beaStats.paid).toBe(5);
    expect(beaStats.paidKnown).toBe(true);
    expect(beaStats.method).toBe("venmo");
    expect(beaStats.methods).toEqual(["venmo", "payat"]);
    expect(beaStats.walkIn).toBe(true);
    expect(beaStats.firstVisit).toBe("2026-07-01");
    expect(beaStats.lastVisit).toBe("2026-10-04");
    const deeStats = api.clientListStats(dee, appointments, stubOptions);
    expect(deeStats.visits).toBe(0);
    expect(deeStats.paidKnown).toBe(false);
    expect(deeStats.method).toBe("");
    expect(api.clientIsWalkIn({ source: "Walk-in" }, [])).toBe(true);
    expect(api.clientIsWalkIn({ source: "manual" }, [{ clientEmail: "nope@example.com", walkIn: true }])).toBe(false);
    const tied = api.clientListStats(
      { email: "tie@example.com" },
      [
        { clientEmail: "tie@example.com", date: "2026-10-01", time: "09:00 AM", kind: "card" },
        { clientEmail: "tie@example.com", date: "2026-10-02", time: "09:00 AM", kind: "venmo" },
      ],
      stubOptions,
    );
    expect(tied.method).toBe("venmo");
    const payAtTie = api.clientListStats(
      { email: "tie@example.com" },
      [
        { clientEmail: "tie@example.com", date: "2026-10-01", time: "09:00 AM", kind: "card" },
        { clientEmail: "tie@example.com", date: "2026-10-04", time: "09:00 AM", status: "accepted", paymentStatus: "PAY AT APPOINTMENT", kind: "unpaid" },
      ],
      stubOptions,
    );
    expect(payAtTie.method).toBe("card");
    expect(api.clientVisitMethod({ status: "pending", paymentStatus: "PENDING ZELLE", kind: "unpaid" }, () => "unpaid")).toBe("");
    expect(api.clientVisitMethod({ status: "denied", paymentStatus: "PAY AT APPOINTMENT" }, () => "unpaid")).toBe("");
    expect(api.clientVisitMethod({ status: "accepted", paymentStatus: "PAY AT APPOINTMENT" }, () => "unpaid")).toBe("payat");
  });

  it("exports the arranged rows with the reports-style CSV escaping", () => {
    const rows = api.clientListArrange(clients, appointments, { ...stubOptions, sort: "name", dir: "asc", walkOnly: true });
    const csv = api.clientListCsv(rows);
    const lines = csv.split("\n");
    expect(lines[0]).toBe("name,email,phone,visits,total_paid,payment_methods,most_used_method,walk_in,first_visit,last_visit,notes");
    expect(lines).toHaveLength(3);
    expect(lines[1].startsWith("Bea,bea@example.com,5552222222,3,5.00,")).toBe(true);
    expect(lines[1]).toContain("Venmo; Pay at appt,Venmo,yes,2026-07-01,2026-10-04");
    expect(lines[2]).toContain("Eve,eve@example.com,5555555555,2,0.00,In person / Cash,In person / Cash,yes,2026-08-01,2026-08-02");
    const quoted = api.clientListCsv(api.clientListArrange([dee], [], { ...stubOptions, sort: "name", dir: "asc" }));
    expect(quoted).toContain('"dee, ""quoted""",dee@example.com,5554444444,0,,');
    expect(quoted).toContain(",no,,");
    expect(quoted.trim().endsWith(",quoted note")).toBe(true);
    const injected = api.clientListCsv([
      { name: "=cmd", email: "+ada@example.com", phone: "+15551212", stats: { visits: 1, paid: 0, paidKnown: true, method: "venmo", methodLabel: "@venmo", methods: ["cash"], methodLabels: ["-cash"], walkIn: false, firstVisit: "", lastVisit: "" } },
    ]);
    expect(injected).toContain("'=cmd,'+ada@example.com,'+15551212,1,0.00,'-cash,'@venmo,no,,");
    const noted = api.clientListCsv([
      { name: "Ann", email: "ann@example.com", phone: "5551212", notes: "=secret\n<script>", stats: { visits: 0, paid: 0, paidKnown: false, method: "", methodLabel: "", methods: [], methodLabels: [], walkIn: false, firstVisit: "", lastVisit: "" } },
    ]);
    expect(noted).toContain("\"'=secret\n<script>\"");
  });

  it("uses the reports done rule and the roster net-paid total", () => {
    const asOf = { date: "2026-10-16", minutes: 12 * 60 };
    const tenant = {
      services: [
        { name: "Beard trim", price: 28 },
        { name: "Cut & style", price: 65 },
      ],
    };
    const maya = { name: "Maya Chen", email: "maya@example.com", phone: "(555) 201-0142" };
    const rows = [
      { date: "2026-10-15", time: "09:00 AM", status: "accepted", clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "card", amount: 65 },
      { date: "2026-10-16", time: "09:00 AM", status: "completed", clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "venmo", amount: 40 },
      { date: "2026-10-16", time: "03:00 PM", status: "accepted", clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "venmo", amount: 10 },
      { date: "2026-10-20", time: "09:00 AM", status: "completed", clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "card", amount: 120 },
      { date: "2026-10-10", time: "09:00 AM", status: "accepted", noShow: true, clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "cash", amount: 65 },
      { date: "2026-10-09", time: "09:00 AM", status: "cancelled", clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "card", amount: 28 },
      { date: "2026-10-08", time: "09:00 AM", status: "pending", clientEmail: "maya@example.com", paymentStatus: "PENDING ZELLE", paymentMethod: "zelle", amount: 28 },
      { date: "2026-10-07", time: "09:00 AM", status: "denied", clientEmail: "maya@example.com", paymentStatus: "PAY AT APPOINTMENT", amount: 80 },
      { date: "2026-10-14", time: "11:00 AM", status: "accepted", clientEmail: "maya@example.com", paymentStatus: "DEPOSIT PAID", paidMethod: "card", amount: 120, depositAmount: 36, depositPaid: true },
      { date: "2026-10-13", time: "11:00 AM", status: "accepted", clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "cash", amount: 65, refundAmount: 20 },
      { date: "2026-10-12", time: "11:00 AM", status: "accepted", clientEmail: "maya@example.com", paymentStatus: "PAID", paidMethod: "cashapp", serviceName: "Beard trim" },
      { date: "2026-10-16", time: "01:00 PM", status: "accepted", clientEmail: "maya@example.com", paymentStatus: "PAY AT APPOINTMENT", amount: 80, walkIn: true },
      { date: "2026-10-15", time: "09:00 AM", status: "accepted", clientEmail: "other@example.com", paymentStatus: "PAID", paidMethod: "card", amount: 999 },
    ];
    expect(api.appointmentCompletionOf(rows[2], asOf)).toBe("");
    expect(api.appointmentCompletionOf(rows[4], asOf)).toBe("not_done");
    expect(api.rosterAmountCollected(rows[8], tenant).net).toBe(36);
    expect(api.rosterAmountCollected(rows[9], tenant).net).toBe(45);
    expect(api.rosterAmountCollected(rows[10], tenant).net).toBe(28);
    expect(api.appointmentPayKind(rows[11])).toBe("unpaid");
    const stats = api.clientListStats(maya, rows, {
      doneOf: (app: Record<string, unknown>) => api.appointmentCompletionOf(app, asOf),
      collectedOf: (app: Record<string, unknown>) => api.rosterAmountCollected(app, tenant),
      payKind: api.appointmentPayKind,
    });
    expect(stats.visits).toBe(5);
    expect(stats.paid).toBe(437);
    expect(stats.method).toBe("card");
    expect(stats.methodLabel).toBe("Card (Stripe)");
    expect(stats.methodLabels).toEqual(["Venmo", "Cash App", "Card (Stripe)", "In person / Cash", "Pay at appt"]);
    expect(stats.walkIn).toBe(true);
    expect(stats.firstVisit).toBe("2026-10-07");
    expect(stats.lastVisit).toBe("2026-10-20");
  });

  it("keeps the list controls in the new dashboard stylesheet", () => {
    expect(html).toContain("Export clients CSV");
    expect(html).toContain('id="clientSort"');
    expect(html).toContain("Visits (done)");
    expect(html).toContain("return appointmentCompletionOf(app, asOf);");
    expect(html).toContain("return rosterAmountCollected(app, tenant);");
    const css = dashCss(html);
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-client-export {\n        grid-column: 1 / -1;\n        width: 100%;");
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-client-paid-figure");
    const metrics = extractFunction(html, "clientMetricsHtml");
    expect(metrics).toContain("formatBookingAmountLabel(stats.paid)");
    expect(metrics).not.toContain("toFixed(2)");
    const menu = html.slice(html.indexOf("More actions for "), html.indexOf("function clientTagsHtml"));
    expect(menu.indexOf("Book appointment")).toBeGreaterThan(-1);
    expect(menu.indexOf("Book appointment")).toBeLessThan(menu.indexOf("View history"));
    expect(menu.indexOf("View history")).toBeLessThan(menu.indexOf(">Remove</button>"));
    expect(menu).toContain('class="sd-act-no sd-act-delete" role="menuitem"');
    const svc36 = css.indexOf("#tenantPortalSection.schedi-newdash #tenantServicesGrid .sd-svc-edit,\n#tenantPortalSection.schedi-newdash #tenantServicesGrid .sd-svc-delete {\n    min-height: 36px;");
    const svc48 = css.indexOf("    #tenantPortalSection.schedi-newdash #tenantServicesGrid .sd-svc-edit,\n    #tenantPortalSection.schedi-newdash #tenantServicesGrid .sd-svc-delete {\n        min-height: 48px;");
    expect(svc36).toBeGreaterThan(-1);
    expect(svc48).toBeGreaterThan(svc36);
    expect(css).toContain("#tenantPortalSection.schedi-newdash .sd-client-walk");
  });
});
