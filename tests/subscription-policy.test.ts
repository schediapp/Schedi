import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  OWNER_SUBSCRIPTION_POLICY_SHORT,
  OWNER_SUBSCRIPTION_POLICY_TERMS,
  planStaysActiveUntil,
  subscriptionPeriodEndIso,
} from "../src/lib/subscription-policy";
import { MARKETING_PAGES } from "../worker/content";
import { renderMarketingPage } from "../worker/render";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const billing = readFileSync(new URL("../src/lib/billing.ts", import.meta.url), "utf8");
const webhooks = readFileSync(new URL("../src/lib/webhooks.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const connectPlan = readFileSync(new URL("../connect-recommend-plan.md", import.meta.url), "utf8");

describe("owner subscription refund and cancellation policy", () => {
  it("states the full policy in terms and the short policy next to subscribe and cancel", () => {
    for (const paragraph of OWNER_SUBSCRIPTION_POLICY_TERMS) {
      expect(html).toContain(paragraph);
    }
    expect(html.split(OWNER_SUBSCRIPTION_POLICY_SHORT).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Cancel subscription");
    expect(html).toContain("Resume subscription");
    expect(html).toContain("Your plan stays active until ");
    expect(html).not.toContain("After 15 days, that month is not refunded");
    expect(html).not.toContain("Canceling still stops the next renewal");
    expect(html.match(/id="tenantBillingCard"/g)?.length).toBe(1);
    expect(html.match(/id="tenantBillingUntil"/g)?.length).toBe(1);
    expect(html.match(/id="tenantBillingPolicy"/g)?.length).toBe(1);
    const compareStart = html.indexOf("function buildSchediPlanCompareTableHtml");
    const compareEnd = html.indexOf("function buildSchediPlanCompareCardsHtml");
    const compareFn = html.slice(compareStart, compareEnd);
    expect(compareFn).toContain("buildSchediPlanCompareCardsHtml(rows)");
    expect(compareFn).toContain("SCHEDI_OWNER_POLICY_SHORT");
    expect(html.indexOf('id="tenantBannerPublicUrl"')).toBeLessThan(html.indexOf('id="tenantBillingCard"'));
  });

  it("states the same policy on the crawlable marketing pages", () => {
    const retired = [
      "After 15 days, that month is not refunded",
      "Canceling still stops the next renewal",
      "first paid Schedi subscription charge",
      "15-day refund",
    ];
    const rendered = MARKETING_PAGES.map((page) => ({ path: page.path, html: renderMarketingPage(page) }));
    for (const page of rendered) {
      for (const phrase of retired) {
        expect(page.html, page.path).not.toContain(phrase);
      }
    }
    const required = [
      "month-to-month, with no contract",
      "end of the current paid billing period",
      "keeps access until then and is not charged again",
      "full refund of their first payment within 15 days",
      "admin@schedi.app",
      "Renewal payments are not refunded or prorated",
      "billing errors or service outages",
      "Complimentary plans are unaffected.",
      "not a client's appointment deposit",
    ];
    for (const path of ["/", "/pricing", "/help", "/terms"]) {
      const html = rendered.find((page) => page.path === path)?.html ?? "";
      for (const phrase of required) {
        const escaped = phrase.replaceAll("'", "&#39;");
        expect(html.includes(phrase) || html.includes(escaped), `${path} missing: ${phrase}`).toBe(true);
      }
    }
    const pricing = rendered.find((page) => page.path === "/pricing")?.html ?? "";
    expect(pricing).toContain("Canceling keeps access until the paid period ends and does not pause the page.");
    expect(pricing).not.toContain("failed or canceled owner subscription");
  });

  it("formats the active-until date the same way in the portal script", () => {
    const start = html.indexOf("function ownerPlanActiveUntilText");
    const end = html.indexOf("function syncTenantBillingUntil");
    expect(start).toBeGreaterThan(-1);
    const format = new Function(`${html.slice(start, end)}; return ownerPlanActiveUntilText;`)() as (iso: string) => string;
    expect(format("2026-11-07T00:00:00.000Z")).toBe("Your plan stays active until November 7, 2026");
    expect(format("2026-11-07T00:00:00.000Z")).toBe(planStaysActiveUntil("2026-11-07T00:00:00.000Z"));
    expect(format("")).toBe("");
  });

  it("schedules cancel at period end and downgrades only when the subscription is deleted", () => {
    expect(billing).toContain("custom_text: ownerCheckoutCustomText()");
    expect(billing).toContain("cancel_at_period_end: true");
    expect(billing).toContain("cancel_at_period_end: false");
    expect(billing).not.toContain("subscriptions.cancel");
    expect(webhooks).toContain('case "customer.subscription.deleted"');
    expect(webhooks).not.toContain('case "customer.subscription.updated":\n    case "customer.subscription.deleted"');
    expect(readme).toContain("cancel_at_period_end=true");
    expect(readme).toContain("customer.subscription.deleted");
    expect(connectPlan).toContain("Cancellation takes effect at the end of the current paid billing period");
    expect(connectPlan).toContain("Requesting cancellation does not");
  });

  it("reads the period end from cancel_at, then the subscription, then the item", () => {
    expect(subscriptionPeriodEndIso({
      cancel_at_period_end: true,
      cancel_at: 1794009600,
      current_period_end: 1,
    })).toBe("2026-11-07T00:00:00.000Z");
    expect(subscriptionPeriodEndIso({
      items: { data: [{ current_period_end: 1794009600 }] },
    })).toBe("2026-11-07T00:00:00.000Z");
    expect(planStaysActiveUntil("not-a-date")).toBe("Your plan stays active until not-a-date");
  });

  it("keeps the owner portal script parseable", () => {
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    const owner = scripts.find((match) => match[1]?.includes("function ownerPlanActiveUntilText"));
    expect(owner).toBeTruthy();
    expect(() => new Script(owner?.[1] ?? "", { filename: "index-portal.js" })).not.toThrow();
  });
});
