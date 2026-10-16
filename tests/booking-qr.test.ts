import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const jsQR = require("jsqr") as (
  data: Uint8ClampedArray,
  width: number,
  height: number
) => { data: string } | null;
const { schediQrModules, schediQrCardPixels } = require("../src/lib/booking-qr.js") as {
  schediQrModules: (text: string, level?: string) => { size: number; version: number; mask: number; dark: Uint8Array } | null;
  schediQrCardPixels: (text: string, color?: string) => { width: number; height: number; data: Uint8ClampedArray } | null;
};

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const lib = readFileSync(new URL("../src/lib/booking-qr.js", import.meta.url), "utf8").replace(/\n?if \(typeof module[\s\S]*$/, "");

describe("booking QR code", () => {
  it("draws the same modules as a standard byte-mode code", () => {
    const qr = schediQrModules("https://schedi.app/harbor-demo/");
    expect(qr).not.toBeNull();
    if (!qr) return;
    expect(qr.version).toBe(3);
    expect(qr.mask).toBe(2);
    expect(qr.size).toBe(29);
    let sum = 0;
    for (let i = 0; i < qr.dark.length; i++) sum = (Math.imul(sum, 33) + qr.dark[i]) >>> 0;
    expect(sum).toBe(3281830895);
    expect(schediQrModules("a".repeat(217))).toBeNull();
  });

  it("draws the Schedi card at error correction H and the center still scans", () => {
    const text = "https://schedi.app/harbor-demo/";
    const qr = schediQrModules(text, "H");
    expect(qr).not.toBeNull();
    if (!qr) return;
    expect(qr.version).toBe(4);
    expect(qr.mask).toBe(6);
    expect(qr.size).toBe(33);
    let sum = 0;
    for (let i = 0; i < qr.dark.length; i++) sum = (Math.imul(sum, 33) + qr.dark[i]) >>> 0;
    expect(sum).toBe(1690195867);
    const pixels = schediQrCardPixels(text);
    expect(pixels).not.toBeNull();
    if (!pixels) return;
    expect(pixels.width + 160).toBeGreaterThanOrEqual(1000);
    const found = jsQR(pixels.data, pixels.width, pixels.height);
    expect(found && found.data).toBe(text);
    const branded = schediQrCardPixels(text, "#10b981");
    expect(branded).not.toBeNull();
    if (!branded) return;
    let sawBrand = false;
    for (let i = 0; i < branded.data.length; i += 4) {
      if (branded.data[i] === 16 && branded.data[i + 1] === 185 && branded.data[i + 2] === 129) {
        sawBrand = true;
        break;
      }
    }
    expect(sawBrand).toBe(true);
  });

  it("keeps the portal copy of the generator in step with the library", () => {
    expect(html).toContain(lib.trim());
  });

  it("adds Show QR code beside Copy booking link on the new dashboard only", () => {
    const actionsAt = html.indexOf('class="sd-today-actions"');
    const actions = html.slice(actionsAt, actionsAt + 900);
    expect(actions.indexOf("Copy booking link")).toBeGreaterThan(-1);
    expect(actions.indexOf("Copy booking link")).toBeLessThan(actions.indexOf("Show QR code"));
    expect(actions).toContain('id="schediQrOpenBtn"');
    expect(actions).toContain("fa-qrcode");
    const old = html.indexOf('title="Copy public booking link"');
    expect(html.slice(old, old + 500)).not.toContain("Show QR code");
    expect(html).toContain('id="schediQrModal"');
    expect(html).toContain("Upload QR code");
    expect(html).toContain("Generate one from my booking link");
    expect(html).toContain("Schedi Me");
    expect(html).toContain("https://schedi.app/' + slug + '/'");
    expect(html).toContain("document.fonts");
    expect(html).toContain("schediQrCardPixels");
    const generateAt = html.indexOf("window.schediQrGenerate = function");
    const generate = html.slice(generateAt, generateAt + 3200);
    expect(generate).toContain("schediQrDrawCard");
    expect(generate).not.toContain("getTenantPublicBookingUrl");
    expect(generate).toContain("Not saved in this demo. The preview stays on this screen only.");
    expect(html).toContain("Change QR code");
    expect(html).toContain("Confirm replacement");
    expect(html).toContain('id="schediQrChange"');
    const qrActions = html.indexOf('id="schediQrDownload"');
    const qrRow = html.slice(qrActions, qrActions + 700);
    expect(qrRow.indexOf("Download")).toBeLessThan(qrRow.indexOf("Print"));
    expect(qrRow.indexOf("Print")).toBeLessThan(qrRow.indexOf("Change QR code"));
    expect(html).toContain("Not saved in this demo. The preview stays on this screen only.");
    expect(html).toContain("QR upload is not turned on yet. The preview stays on this screen only.");
    expect(html).toContain("purpose: 'qr'");
    expect(html).toContain("saveState({ profileOnly: true, tenantIds: [tenant.id], quietSyncErrors: true })");
    expect(html).toContain("#tenantPortalSection.schedi-newdash .sd-qr-card");
    expect(html).toContain("max-height: min(92vh, 760px)");
    expect(html).toContain("#tenantPortalSection.schedi-newdash .sd-today-actions .sd-share");
  });
});
