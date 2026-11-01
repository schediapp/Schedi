import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isMedicalIndustry } from "../workers/schedi-email-worker/src/phi-ack.js";
import { INDUSTRY_CHOICES, INDUSTRY_PRESETS } from "../workers/schedi-email-worker/src/industry-presets.js";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const hqHtml = readFileSync(new URL("../site/hq.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../workers/schedi-email-worker/src/index.js", import.meta.url), "utf8");

const ADDED = [
  "Nail salon",
  "Lash / brow",
  "Spa / massage",
  "Esthetician",
  "Tattoo / piercing",
  "Personal trainer",
  "Yoga / pilates",
  "Pet grooming",
  "Dog training",
  "Mobile car wash",
  "House cleaning",
  "Photography",
  "Tutoring",
  "Music lessons",
  "Coaching",
  "Makeup artist",
  "Event / party rentals",
];

function selectOptions(html: string, id: string) {
  const at = html.indexOf(`id="${id}"`);
  expect(at).toBeGreaterThan(-1);
  const open = html.indexOf(">", at);
  const close = html.indexOf("</select>", open);
  const block = html.slice(open, close);
  return [...block.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((match) => ({
    value: match[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'),
    label: match[2].replace(/&amp;/g, "&").replace(/&lt;/g, "<"),
  }));
}

describe("industry presets", () => {
  it("keeps saved industry values and adds the new owner labels", () => {
    expect(INDUSTRY_CHOICES.slice(0, 1)).toEqual(["Services"]);
    for (const stable of ["Services", "Consulting", "Barbershop", "Medical", "Auto", "Fitness"]) {
      expect(INDUSTRY_CHOICES).toContain(stable);
    }
    expect(INDUSTRY_PRESETS.find((row) => row.value === "Barbershop")?.label).toBe("Barbershop / Hair salon");
    expect(INDUSTRY_PRESETS.find((row) => row.value === "Consulting")?.label).toBe("Consulting / Executive");
    expect(INDUSTRY_PRESETS.find((row) => row.value === "Auto")?.label).toBe("Auto detailing");
    expect(INDUSTRY_PRESETS.find((row) => row.value === "Fitness")?.label).toBe("Fitness & Personal Training");
    for (const label of ADDED) {
      expect(INDUSTRY_CHOICES).toContain(label);
    }
    expect(new Set(INDUSTRY_CHOICES).size).toBe(INDUSTRY_CHOICES.length);
  });

  it("uses the same options on signup, the owner profile, and HQ", () => {
    const expected = INDUSTRY_PRESETS.map((row) => ({ value: row.value, label: row.label }));
    for (const html of [indexHtml, hqHtml]) {
      expect(selectOptions(html, "signupIndustry")).toEqual(expected);
      expect(selectOptions(html, "tenantIndustry")).toEqual(expected);
    }
    expect(selectOptions(hqHtml, "provIndustry")).toEqual(expected);
    expect(selectOptions(hqHtml, "editTenantIndustry")).toEqual(expected);
    expect(worker).toContain("INDUSTRY_CHOICES.indexOf(industry)");
    expect(worker).not.toContain("['Services', 'Consulting', 'Barbershop', 'Medical', 'Auto', 'Fitness']");
  });

  it("keeps the health-information acknowledgment on Medical only", () => {
    expect(isMedicalIndustry("Medical")).toBe(true);
    expect(isMedicalIndustry("Medical / Healthcare")).toBe(true);
    expect(isMedicalIndustry("healthcare")).toBe(true);
    for (const value of INDUSTRY_CHOICES) {
      if (value === "Medical") continue;
      expect(isMedicalIndustry(value)).toBe(false);
    }
    expect(indexHtml).toContain("schediPhiAckToggle('signup')");
    expect(indexHtml).toContain("schediPhiAckToggle('tenant')");
    expect(hqHtml).toContain("schediPhiAckToggle('edit')");
    expect(hqHtml).toContain("schediIndustryHipaaNote()");
  });
});

describe("HQ client edit", () => {
  it("edits name, email, phone, and notes from the list without touching bookings", () => {
    const start = hqHtml.indexOf("function clientEditFormHtml");
    const end = hqHtml.indexOf("window.toggleClientAddForm");
    const block = hqHtml.slice(start, end);
    expect(block).toContain("id=\"clientEditName\"");
    expect(block).toContain("id=\"clientEditEmail\"");
    expect(block).toContain("id=\"clientEditPhone\"");
    expect(block).toContain("id=\"clientEditNotes\"");
    expect(block).toContain("esc(x.name");
    expect(block).toContain("esc(x.notes");
    expect(block).toContain("action: 'update'");
    expect(block).toContain("notes:");
    expect(block).toContain("tags: current.tags || []");
    expect(block).not.toContain("saveState");
    expect(block).not.toContain("appointments");
    expect(hqHtml).toContain("startOwnerClientEdit(");
    expect(hqHtml).toContain(">Edit</button>");
    const emailStart = hqHtml.indexOf("var CLIENT_EMAIL_RE");
    const emailLine = hqHtml.slice(emailStart, hqHtml.indexOf("\n", emailStart));
    const validate = new Function(`${emailLine}\n${extractFunction(hqHtml, "duplicatedEmailTld")}\n${extractFunction(hqHtml, "duplicatedEmailTldWarning")}\n${extractFunction(hqHtml, "clientCleanText")}\n${extractFunction(hqHtml, "clientPhoneKey")}\n${extractFunction(hqHtml, "validateClientRow")}; return validateClientRow;`)() as (raw: Record<string, string>) => { client?: { notes: string; name: string; email: string; phone: string }; error?: string; empty?: boolean };
    expect(validate({ name: "Maya", email: "maya@example.com", phone: "(555) 201-0142", notes: "" }).client).toMatchObject({
      name: "Maya",
      email: "maya@example.com",
      phone: "(555) 201-0142",
      notes: "",
    });
    expect(validate({ name: "Maya", email: "maya@example.com", phone: "", notes: "Prefers mornings" }).client?.notes).toBe("Prefers mornings");
    expect(validate({ name: "Maya <script>", email: "maya@example.com", notes: "a\u0000b" }).client).toMatchObject({
      name: "Maya <script>",
      notes: "a b",
    });
    expect(validate({ name: "", email: "maya@example.com" }).error).toBe("missing_name");
  });
});

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
