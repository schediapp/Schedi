import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeProfile, sanitizeService } from "../workers/schedi-email-worker/src/profile-store.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

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

describe("service icon allow list", () => {
  it("keeps icon and https imageUrl and drops data URLs and unknown fields", () => {
    const row = sanitizeService({
      id: 3,
      name: "Cut & style",
      duration: "45 mins",
      durationMins: 45,
      price: 65,
      desc: "Cut, style, and finish.",
      icon: "Fa-Scissors",
      imageUrl: "https://logos.example.test/logos/harbor/services/3.png",
      iconImage: "data:image/png;base64,aaaa",
      role: "owner",
    });
    expect(row).toEqual({
      id: 3,
      name: "Cut & style",
      duration: "45 mins",
      durationMins: 45,
      price: 65,
      desc: "Cut, style, and finish.",
      icon: "fa-scissors",
      imageUrl: "https://logos.example.test/logos/harbor/services/3.png",
    });
    const blocked = sanitizeService({
      id: "svc-1",
      name: "Gloss",
      icon: "fa-droplet",
      imageUrl: "blob:http://127.0.0.1/preview",
      iconImage: "data:image/png;base64,bbbb",
      role: "owner",
    });
    expect(blocked).toEqual({ id: "svc-1", name: "Gloss", icon: "fa-droplet" });
    expect(sanitizeService({ name: "Color", imageUrl: "http://logos.example.test/a.png" })).toEqual({ name: "Color" });
  });

  it("applies the service allow list when a profile is saved", () => {
    const profile = sanitizeProfile({
      name: "Harbor Studio",
      ownerPassword: "secret",
      services: [
        {
          id: 1,
          name: "Cut",
          icon: "fa-scissors",
          imageUrl: "https://cdn.example/a.png",
          iconImage: "data:image/png;base64,cccc",
          role: "nope",
        },
      ],
    }, "harbor");
    expect(profile && profile.ownerPassword).toBeUndefined();
    expect(profile && profile.services).toEqual([
      { id: 1, name: "Cut", icon: "fa-scissors", imageUrl: "https://cdn.example/a.png" },
    ]);
  });
});

describe("owner service images", () => {
  it("draws built-in icons as inline SVGs and keeps demo uploads local", () => {
    const markup = extractFunction(html, "serviceIconMarkup");
    expect(markup).toContain("serviceSvgMarkup");
    expect(markup).not.toContain("fa-solid");
    expect(html).toContain('id="svcIconGrid"');
    expect(html).toContain("Upload your own");
    expect(html).toContain("Current icon");
    expect(html).toContain("<svg viewBox=\"0 0 24 24\"");
    const store = extractFunction(html, "storeLogoBlob");
    const beforeFetch = store.slice(0, store.indexOf("api/logo-upload"));
    expect(store.indexOf("__SCHEDI_DEMO")).toBeLessThan(store.indexOf("api/logo-upload"));
    expect(beforeFetch).toContain("serviceId");
    expect(beforeFetch).not.toContain("imageUrl");
    expect(store).toContain("payload.serviceId");
    expect(html).toContain("serviceMarkHtml");
    expect(html).toContain('class="sd-svc-mark"');
    const save = html.slice(html.indexOf("window.handleAddServiceSubmit = function"), html.indexOf("window.deleteService = function"));
    expect(save).toContain("svc.icon = icon");
    expect(save).toContain("imageUrl");
    expect(save).not.toContain("iconImage =");
    const templateStart = html.indexOf("return `<!DOCTYPE html>");
    expect(html.indexOf('id="svcIconGrid"')).toBeLessThan(templateStart);
    expect(html.slice(templateStart, html.indexOf("</html>`", templateStart))).not.toContain("sd-svc-mark");
  });
});
