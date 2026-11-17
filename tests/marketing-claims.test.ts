import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { POWERED_BY_HREF } from "../src/components/powered-by";
import { MARKETING_PAGES } from "../worker/content";
import { fillBookingDocument } from "../worker/booking-document";
import { planCardsHtml, renderMarketingPage } from "../worker/render";

const bookingHtml = readFileSync(new URL("../site/booking.html", import.meta.url), "utf8");
const ownerHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hqHtml = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const portalPage = readFileSync(new URL("../src/app/portal/page.tsx", import.meta.url), "utf8");

const POWERED_HREF = "https://schedi.app/?utm_source=booking_page&amp;utm_medium=referral&amp;utm_campaign=powered_by";

describe("pricing has no per-booking fee", () => {
  it("puts the no-commission line under the plan cards and leaves prices and Pro-only copy", () => {
    const pricing = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/pricing")!);
    const home = renderMarketingPage(MARKETING_PAGES.find((page) => page.path === "/")!);
    expect(pricing).toContain("No commission or per-booking fees. Just a flat monthly price. Stripe's standard card processing applies when you take card payments.");
    expect(pricing).toContain('class="amt">$0<');
    expect(pricing).toContain('class="amt">$29<');
    expect(pricing).toContain('class="amt">$49<');
    expect(pricing).toContain("Sending invoices with payment links is Pro only.");
    expect(pricing).toContain("the deposit stays off until you turn it on");
    expect(home).not.toContain("No commission or per-booking fees.");
    expect(planCardsHtml()).not.toContain("fee-note");
    expect(planCardsHtml({ feeNote: true })).toContain("fee-note");
  });
});

describe("powered by Schedi on public booking pages", () => {
  it("shows a followed link on every plan and keeps it out of the owner dashboard chrome", () => {
    expect(bookingHtml).toContain(`<a href="${POWERED_HREF}">Powered by Schedi</a>`);
    const footer = bookingHtml.slice(bookingHtml.indexOf('<footer class="pub-powered">'), bookingHtml.indexOf("</footer>") + "</footer>".length);
    expect(footer).not.toMatch(/nofollow|sponsored|ugc/i);
    expect(footer).not.toContain("target=");

    for (const plan of ["free", "starter", "pro"]) {
      const filled = fillBookingDocument(bookingHtml, {
        slug: "fresh-cuts",
        fields: { name: "Fresh Cuts Studio", plan, industry: "Barbershop" },
      });
      expect(filled, plan).toContain(POWERED_HREF);
      expect(filled, plan).toContain("Powered by Schedi");
    }
    const free = fillBookingDocument(bookingHtml, { slug: "fresh-cuts", fields: { name: "Fresh Cuts", plan: "free" } });
    const pro = fillBookingDocument(bookingHtml, { slug: "fresh-cuts", fields: { name: "Fresh Cuts", plan: "pro" } });
    expect(free).toContain(">Schedi</span>");
    expect(pro).not.toContain(">Schedi</span>");

    const ownerFn = ownerHtml.indexOf("function generateStandaloneHtmlForTenant");
    const hqFn = hqHtml.indexOf("function generateStandaloneHtmlForTenant");
    expect(ownerHtml.slice(0, ownerFn)).not.toContain('class="pub-powered"');
    expect(hqHtml.slice(0, hqFn)).not.toContain('class="pub-powered"');
    expect(ownerHtml.slice(ownerFn)).toContain('class="pub-powered"');
    expect(portalPage).not.toContain("Powered by Schedi");
    expect(portalPage).not.toContain("powered_by");
    expect(POWERED_BY_HREF).toBe("https://schedi.app/?utm_source=booking_page&utm_medium=referral&utm_campaign=powered_by");
  });
});
