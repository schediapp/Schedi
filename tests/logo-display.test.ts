import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const LOGO = "https://schedi.app/logos/aria-rose?v=abc123abc123abc123";

function extractFunction(source: string, name: string): string {
  const start = source.indexOf("function " + name);
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

type El = {
  id: string;
  hidden: boolean;
  textContent: string;
  src: string;
  alt: string;
  className: string;
  classList: { add: () => void; remove: () => void };
  removeAttribute: (name: string) => void;
  setAttribute: () => void;
};

function makeEl(id: string, hidden = false): El {
  const el: El = {
    id,
    hidden,
    textContent: "",
    src: "",
    alt: "",
    className: "",
    classList: { add() {}, remove() {} },
    removeAttribute(name: string) {
      if (name === "src") el.src = "";
      if (name === "href") el.textContent = el.textContent;
    },
    setAttribute() {},
  };
  return el;
}

function dashboardDocument(seed: Record<string, El>) {
  const els = { ...seed };
  return {
    getElementById(id: string) {
      return els[id] || null;
    },
    els,
  };
}

function dashboardEls() {
  return {
    schediDashUserInitials: makeEl("schediDashUserInitials", false),
    schediDashUserLogo: makeEl("schediDashUserLogo", true),
    schediDashUserInitialsPhone: makeEl("schediDashUserInitialsPhone", false),
    schediDashUserLogoPhone: makeEl("schediDashUserLogoPhone", true),
    tenantBannerInitials: makeEl("tenantBannerInitials", false),
    tenantBannerLogo: makeEl("tenantBannerLogo", true),
    tenantLogoUrl: makeEl("tenantLogoUrl", false),
  };
}

function loadDashboard(document: { getElementById: (id: string) => El | null }) {
  const src = [
    extractFunction(html, "schediDashInitials"),
    extractFunction(html, "schediLogoUrl"),
    extractFunction(html, "schediDashPlanLabel"),
    extractFunction(html, "schediDashPaint"),
    extractFunction(html, "paintClassicBannerLogo"),
    extractFunction(html, "schediDashLogoFailed"),
    extractFunction(html, "writeBusinessLogo"),
  ].join("\n");
  const fn = new Function(
    "document",
    "getTenant",
    "schediDashSetPage",
    "schediDashPage",
    `${src}
    return { schediDashPaint, paintClassicBannerLogo, schediDashLogoFailed, writeBusinessLogo, schediLogoUrl };`,
  );
  return fn as (
    document: unknown,
    getTenant: () => unknown,
    schediDashSetPage: () => void,
    schediDashPage: () => string,
  ) => {
    schediDashPaint: () => void;
    paintClassicBannerLogo: (tenant: unknown) => void;
    schediDashLogoFailed: (img: El) => void;
    writeBusinessLogo: (tenant: { logoUrl?: string; logo?: string }, url: string) => string;
    schediLogoUrl: (tenant: unknown) => string;
  };
}

function paintDashboard(tenant: { name: string; logoUrl?: string; logo?: string }) {
  const els = dashboardEls();
  const document = dashboardDocument(els);
  const api = loadDashboard(document)(document, () => tenant, () => {}, () => "today");
  api.schediDashPaint();
  api.paintClassicBannerLogo(tenant);
  return { els, api };
}

function bookingDocument() {
  const ids = [
    "bizLogo",
    "bizLogoInitials",
    "bizLogoWrap",
    "pubHeaderLogo",
    "pubHeaderInitials",
    "bizTitle",
    "bizIndustry",
    "bizAddress",
    "bizHours",
    "bizCoverWrap",
    "bizCover",
    "bizHeader",
  ];
  const els: Record<string, El> = {};
  ids.forEach((id) => {
    els[id] = makeEl(id, id === "bizLogo" || id === "pubHeaderLogo" || id === "pubHeaderInitials");
  });
  return {
    getElementById(id: string) {
      return els[id] || null;
    },
    els,
  };
}

function paintBooking(tenantData: { name: string; logoUrl?: string; logo?: string; businessLogo?: string }) {
  const document = bookingDocument();
  const src = [
    extractFunction(html, "publicHttpsUrl"),
    extractFunction(html, "bizInitials"),
    extractFunction(html, "hideBizImage"),
    extractFunction(html, "mapsHref"),
    "function getPubLocation() { return ''; }",
    "function formatPublicHours() { return ''; }",
    extractFunction(html, "paintBizHeader"),
  ].join("\n");
  const fn = new Function(
    "document",
    "tenantData",
    `${src}
    paintBizHeader();
    return { hideBroken: hideBizImage };`,
  );
  const api = fn(document, tenantData) as { hideBroken: (img: El) => void };
  return { els: document.els, api };
}

describe("business logo display", () => {
  it("paints the sidebar, phone header, and classic banner from logoUrl, then falls back to initials", () => {
    const shown = paintDashboard({ name: "Aria Rose", logoUrl: LOGO, logo: "https://schedi.app/logos/other" });
    for (const id of ["schediDashUserLogo", "schediDashUserLogoPhone", "tenantBannerLogo"] as const) {
      expect(shown.els[id].hidden, id).toBe(false);
      expect(shown.els[id].src, id).toBe(LOGO);
      expect(shown.els[id].alt, id).toContain("Aria Rose");
    }
    for (const id of ["schediDashUserInitials", "schediDashUserInitialsPhone", "tenantBannerInitials"] as const) {
      expect(shown.els[id].hidden, id).toBe(true);
      expect(shown.els[id].textContent, id).toBe("AR");
    }

    const fallback = paintDashboard({ name: "Aria Rose", logoUrl: "", logo: "" });
    for (const id of ["schediDashUserLogo", "schediDashUserLogoPhone", "tenantBannerLogo"] as const) {
      expect(fallback.els[id].hidden, id).toBe(true);
      expect(fallback.els[id].src, id).toBe("");
    }
    for (const id of ["schediDashUserInitials", "schediDashUserInitialsPhone", "tenantBannerInitials"] as const) {
      expect(fallback.els[id].hidden, id).toBe(false);
      expect(fallback.els[id].textContent, id).toBe("AR");
    }

    const broken = paintDashboard({ name: "Aria Rose", logoUrl: LOGO, logo: LOGO });
    broken.api.schediDashLogoFailed(broken.els.schediDashUserLogo);
    broken.api.schediDashLogoFailed(broken.els.schediDashUserLogoPhone);
    broken.api.schediDashLogoFailed(broken.els.tenantBannerLogo);
    expect(broken.els.schediDashUserLogo.hidden).toBe(true);
    expect(broken.els.schediDashUserLogo.src).toBe("");
    expect(broken.els.schediDashUserInitials.hidden).toBe(false);
    expect(broken.els.schediDashUserInitials.textContent).toBe("AR");
    expect(broken.els.schediDashUserInitialsPhone.hidden).toBe(false);
    expect(broken.els.tenantBannerInitials.hidden).toBe(false);
  });

  it("paints the booking header and business card for the current design and ?newbook=1", () => {
    expect(html).toContain("html.schedi-newbook .pub-header-logo, html.schedi-newbook .pub-header-initials { border-radius: 16px; }");
    expect(html).not.toContain("html.schedi-newbook .pub-header-logo { display: none");
    const shown = paintBooking({ name: "Aria Rose", logoUrl: "", logo: LOGO });
    expect(shown.els.pubHeaderLogo.hidden).toBe(false);
    expect(shown.els.pubHeaderLogo.src).toBe(LOGO);
    expect(shown.els.bizLogo.hidden).toBe(false);
    expect(shown.els.bizLogo.src).toBe(LOGO);
    expect(shown.els.pubHeaderInitials.hidden).toBe(true);
    expect(shown.els.pubHeaderInitials.textContent).toBe("AR");
    expect(shown.els.bizLogoInitials.hidden).toBe(true);
    expect(shown.els.bizLogoInitials.textContent).toBe("AR");
    expect(shown.els.bizTitle.textContent).toBe("Aria Rose");

    const fallback = paintBooking({ name: "Aria Rose" });
    expect(fallback.els.pubHeaderLogo.hidden).toBe(true);
    expect(fallback.els.pubHeaderLogo.src).toBe("");
    expect(fallback.els.bizLogo.hidden).toBe(true);
    expect(fallback.els.pubHeaderInitials.hidden).toBe(false);
    expect(fallback.els.pubHeaderInitials.textContent).toBe("AR");
    expect(fallback.els.bizLogoInitials.hidden).toBe(false);
    expect(fallback.els.bizLogoInitials.textContent).toBe("AR");
  });

  it("writes logoUrl and logo on upload and profile save, and a reload still paints that URL", () => {
    const store = extractFunction(html, "storeLogoBlob");
    const tail = store.slice(store.indexOf("writeBusinessLogo(tenant, body.url)"));
    expect(tail.startsWith("writeBusinessLogo(tenant, body.url)")).toBe(true);
    expect(tail.indexOf("schediDashPaint()")).toBeGreaterThan(0);
    expect(tail.indexOf("schediDashPaint()")).toBeLessThan(tail.indexOf("await saveState()"));
    expect(tail.indexOf("paintClassicBannerLogo(tenant)")).toBeLessThan(tail.indexOf("await saveState()"));
    expect(store).toContain("renderLivePreviewIframe()");
    const formAt = html.indexOf("window.handleUpdateShiftsSubmit = function");
    const form = html.slice(formAt, formAt + 4000);
    expect(form.indexOf("writeBusinessLogo(tenant, safeHttpsUrl(logoRaw))")).toBeGreaterThan(-1);
    expect(form.indexOf("writeBusinessLogo(tenant, safeHttpsUrl(logoRaw))")).toBeLessThan(form.indexOf("schediDashPaint()"));

    const persist = [
      "var schediHqTagsServer = false;",
      "var SCHEDI_PRIVATE_TENANT_KEYS = ['ownerName', 'ownerEmail', 'ownerPhone', 'stripeCustomerId', 'stripeSubscriptionId', 'billingExempt', 'complimentaryPro', 'monthlyPrice', 'paymentForm', 'hqTags'];",
      extractFunction(html, "publicTenantForCloud"),
      extractFunction(html, "stripPrivateTenantFields"),
      extractFunction(html, "localTenantCopy"),
    ].join("\n");
    const copy = new Function(`${persist}; return localTenantCopy;`)() as (tenant: unknown) => {
      logoUrl?: string;
      logo?: string;
      ownerEmail?: string;
      appointments?: unknown;
    };
    const els = dashboardEls();
    const document = dashboardDocument(els);
    const tenant = {
      id: "aria-rose",
      name: "Aria Rose",
      logoUrl: "",
      logo: "",
      ownerEmail: "aria@example.com",
      appointments: [{ id: "BK-1" }],
    };
    const api = loadDashboard(document)(document, () => tenant, () => {}, () => "today");
    expect(api.writeBusinessLogo(tenant, LOGO)).toBe(LOGO);
    expect(tenant.logoUrl).toBe(LOGO);
    expect(tenant.logo).toBe(LOGO);
    expect(els.tenantLogoUrl.textContent).toBe("");
    api.schediDashPaint();
    expect(els.schediDashUserLogo.src).toBe(LOGO);

    const stored = copy(tenant);
    expect(stored.logoUrl).toBe(LOGO);
    expect(stored.logo).toBe(LOGO);
    expect(stored.ownerEmail).toBeUndefined();
    expect(stored.appointments).toBeUndefined();

    const again = paintDashboard({ name: "Aria Rose", logoUrl: stored.logoUrl, logo: stored.logo });
    expect(again.els.schediDashUserLogo.src).toBe(LOGO);
    expect(again.els.schediDashUserLogo.hidden).toBe(false);
    expect(again.els.schediDashUserInitials.hidden).toBe(true);
    expect(again.els.schediDashUserLogoPhone.src).toBe(LOGO);
    expect(again.els.tenantBannerLogo.src).toBe(LOGO);
    const booking = paintBooking({ name: "Aria Rose", logoUrl: stored.logoUrl, logo: stored.logo });
    expect(booking.els.pubHeaderLogo.src).toBe(LOGO);
    expect(booking.els.pubHeaderLogo.hidden).toBe(false);
    expect(booking.els.bizLogo.src).toBe(LOGO);
  });
});
