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
    expect(generate).toContain("schediQrPaintExport");
    expect(generate).not.toContain("getTenantPublicBookingUrl");
    expect(generate).toContain("Not saved in this demo. The preview stays on this screen only.");
    expect(generate).toContain("That booking link is too long to draw here. Upload a QR image instead.");
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

  it("saves a QR file with the Web Share API on mobile and a download otherwise", async () => {
    function extract(name: string): string {
      const start = html.indexOf("function " + name);
      const brace = html.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
          depth--;
          if (depth === 0) return html.slice(start, i + 1);
        }
      }
      throw new Error("could not extract " + name);
    }
    const saveAt = html.indexOf("window.schediQrSave = async function");
    const save = html.slice(saveAt, html.indexOf("window.schediQrDownload = async function"));
    expect(save).not.toContain("schediQrDeliverFile");
    expect(save).not.toContain("QR code saved on this device.");
    expect(save).toContain("schediAuthSession");
    expect(save).toContain("purpose: 'qr'");
    expect(save).toContain("QR code saved.");
    expect(save).toContain("This QR code is already saved.");
    const downloadAt = html.indexOf("window.schediQrDownload = async function");
    const download = html.slice(downloadAt, downloadAt + 1400);
    expect(download.indexOf("src.indexOf('https://') === 0")).toBeGreaterThan(-1);
    expect(download.indexOf("src.indexOf('https://') === 0")).toBeLessThan(download.indexOf("fetch(src)"));
    expect(download).toContain("schediQrDeliverFile");
    expect(download).not.toContain("fetch(blob:");
    expect(extract("schediQrLoadImage")).not.toContain("crossOrigin");
    expect(extract("schediQrLoadImage")).toContain("createObjectURL");
    expect(extract("schediQrPaintExport")).toContain("opts.logo = null");

    const clicks: { href: string; download: string }[] = [];
    const shares: { files?: File[]; title?: string }[] = [];
    const device = { mobile: true };
    let shareError: Error | null = null;
    const documentStub = {
      body: { appendChild() {} },
      createElement() {
        return {
          href: "",
          download: "",
          click() { clicks.push({ href: this.href, download: this.download }); },
          remove() {},
        };
      },
    };
    const navigatorStub = {
      share(payload: { files?: File[]; title?: string }) {
        shares.push(payload);
        if (shareError) return Promise.reject(shareError);
        return Promise.resolve();
      },
      canShare(payload: { files?: File[] }) {
        return !!(payload && payload.files && payload.files.length);
      },
    };
    const run = new Function(
      "document",
      "navigator",
      "URL",
      "File",
      "setTimeout",
      "device",
      `function schediIsMobileHomeScreenTarget() { return device.mobile; }
       ${extract("schediQrSharePayload")}
       ${extract("schediQrDownloadBlob")}
       ${extract("schediQrDeliverFile")}
       ${extract("schediQrFileKept")}
       return { schediQrDeliverFile, schediQrFileKept };`,
    );
    const urls = {
      createObjectURL() { return "blob:qr-file"; },
      revokeObjectURL() {},
    };
    const api = run(documentStub, navigatorStub, urls, File, () => 0, device) as {
      schediQrDeliverFile: (blob: Blob) => Promise<string>;
      schediQrFileKept: (delivered: string) => boolean;
    };
    const png = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: "image/png" });
    await expect(api.schediQrDeliverFile(png)).resolves.toBe("shared");
    expect(shares).toHaveLength(1);
    expect(shares[0].title).toBe("Booking QR code");
    expect(shares[0].files?.[0].name).toBe("booking-qr.png");
    expect(shares[0].files?.[0].type).toBe("image/png");
    expect(clicks).toHaveLength(0);
    expect(api.schediQrFileKept("shared")).toBe(true);
    expect(api.schediQrFileKept("aborted")).toBe(false);

    shareError = Object.assign(new Error("no share"), { name: "NotAllowedError" });
    await expect(api.schediQrDeliverFile(png)).resolves.toBe("downloaded");
    expect(clicks).toEqual([{ href: "blob:qr-file", download: "booking-qr.png" }]);

    clicks.length = 0;
    shareError = Object.assign(new Error("dismissed"), { name: "AbortError" });
    await expect(api.schediQrDeliverFile(png)).resolves.toBe("aborted");
    expect(clicks).toHaveLength(0);

    device.mobile = false;
    shares.length = 0;
    await expect(api.schediQrDeliverFile(png)).resolves.toBe("downloaded");
    expect(shares).toHaveLength(0);
    expect(clicks).toEqual([{ href: "blob:qr-file", download: "booking-qr.png" }]);

    const plain = new Blob([Uint8Array.from([1, 2, 3])], { type: "" });
    device.mobile = true;
    shareError = null;
    shares.length = 0;
    await expect(api.schediQrDeliverFile(plain)).resolves.toBe("shared");
    expect(shares[0].files?.[0].type).toBe("image/png");
  });

  it("loads a logo from a same-origin blob and still exports a card with no logo", async () => {
    function extract(name: string): string {
      const start = html.indexOf("function " + name);
      const brace = html.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
          depth--;
          if (depth === 0) return html.slice(start, i + 1);
        }
      }
      throw new Error("could not extract " + name);
    }
    const fetched: string[] = [];
    class FakeImage {
      naturalWidth = 12;
      naturalHeight = 12;
      crossOrigin = "";
      __schediQrObjectUrl = "";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => { if (this.onload) this.onload(); });
      }
    }
    const load = new Function(
      "fetch",
      "Image",
      "URL",
      `${extract("schediQrReleaseLogo")}
       ${extract("schediQrDecodeLogo")}
       ${extract("schediQrLoadImage")}
       return { schediQrLoadImage, schediQrReleaseLogo };`,
    )(
      async (url: string) => {
        fetched.push(url);
        if (url.indexOf("missing") !== -1) throw new Error("network");
        return { ok: true, async blob() { return new Blob([Uint8Array.from([1])], { type: "image/png" }); } };
      },
      FakeImage,
      { createObjectURL() { return "blob:logo"; }, revokeObjectURL() {} },
    ) as {
      schediQrLoadImage: (url: string) => Promise<{ __schediQrObjectUrl?: string; crossOrigin?: string } | null>;
      schediQrReleaseLogo: (img: { __schediQrObjectUrl?: string } | null) => void;
    };
    await expect(load.schediQrLoadImage("")).resolves.toBeNull();
    expect(fetched).toHaveLength(0);
    const logo = await load.schediQrLoadImage("https://schedi.app/logos/axeldelcidphotography?v=1");
    expect(fetched).toEqual(["https://schedi.app/logos/axeldelcidphotography?v=1"]);
    expect(logo && logo.__schediQrObjectUrl).toBe("blob:logo");
    expect(logo && logo.crossOrigin).toBe("");
    load.schediQrReleaseLogo(logo);
    await expect(load.schediQrLoadImage("https://cdn.example/missing.png")).resolves.toBeNull();

    const card = { draws: [] as unknown[], exports: 0 };
    const paint = new Function(
      "document",
      "card",
      `${extract("schediQrPaintExport")}
       function schediQrDrawCard(_canvas, opts) { card.draws.push(opts.logo); return opts.url !== "too-long"; }
       function schediQrReleaseLogo() {}
       function schediQrCanvasBlob() { card.exports += 1; return Promise.resolve(card.exports === 1 ? null : { size: 32, type: "image/png" }); }
       return schediQrPaintExport;`,
    )({ createElement() { return {}; } }, card) as (canvas: object, opts: { url: string; logo: unknown }) => Promise<Blob | false | null>;
    const branded = await paint({}, { url: "https://schedi.app/axeldelcidphotography/", logo: { naturalWidth: 8 } });
    expect(branded && (branded as { size: number }).size).toBe(32);
    expect(card.draws.map((logo) => logo == null)).toEqual([false, true]);
    card.draws.length = 0;
    card.exports = 0;
    const bare = await paint({}, { url: "https://schedi.app/harbor-demo/", logo: null });
    expect(bare).toBeNull();
    expect(card.draws).toHaveLength(1);
    await expect(paint({}, { url: "too-long", logo: null })).resolves.toBe(false);
  });

  it("sends the managed business for an agency session and asks an expired owner to sign in", async () => {
    const start = html.indexOf("function schediManagedTenantId");
    const saveStart = html.indexOf("window.schediQrSave = async function");
    const saveEnd = html.indexOf("window.schediQrDownload = async function");
    const source = html.slice(start, html.indexOf("window.schediQrSave = async function")) + html.slice(saveStart, saveEnd);
    const toasts: string[] = [];
    const posts: { tenantId?: string; purpose?: string }[] = [];
    const auth = { role: "agency" as string, result: { ok: false, status: 401, error: "session_expired", url: "" } };
    const run = new Function(
      "fetch",
      "localStorage",
      "showToast",
      "auth",
      `var window = {};
       var schediQrPending = { blob: { type: "image/png" }, type: "image/png" };
       var platformState = {
         get isAgencyMasterLoggedIn() { return auth.role === "agency"; },
         get ownerSelfSession() { return auth.role !== "agency"; },
         activeTenantId: "axeldelcidphotography"
       };
       function schediQrDeliverFile() { return Promise.resolve("failed"); }
       function schediQrFileKept() { return false; }
       function getTenant() { return { id: "axeldelcidphotography" }; }
       function schediAuthSession() { return "agency-token"; }
       function schediAuthMeta() { return { role: auth.role }; }
       function blobToBase64() { return Promise.resolve("abc"); }
       function safeHttpsUrl(value) { return String(value || "").indexOf("https://") === 0 ? value : ""; }
       function saveState() { return Promise.resolve(); }
       function schediQrShowFilled() {}
       ${source}
       return window.schediQrSave;`,
    ) as (fetchImpl: typeof fetch, storage: { getItem: () => string }, toast: (message: string) => void, authState: typeof auth) => () => Promise<void>;
    const save = run(
      (async (_url: string, init?: RequestInit) => {
        posts.push(JSON.parse(String(init?.body || "{}")));
        return {
          ok: auth.result.ok,
          status: auth.result.status,
          json: async () => ({ ok: auth.result.ok, error: auth.result.error, url: auth.result.url }),
        };
      }) as unknown as typeof fetch,
      { getItem: () => "" },
      (message: string) => { toasts.push(message); },
      auth,
    );
    await save();
    expect(toasts).toEqual(["Please sign in again to upload"]);
    expect(posts[0]).toMatchObject({ tenantId: "axeldelcidphotography", purpose: "qr" });

    toasts.length = 0;
    posts.length = 0;
    auth.role = "owner";
    auth.result = { ok: false, status: 401, error: "session_expired", url: "" };
    await save();
    expect(posts[0].tenantId).toBeUndefined();
    expect(toasts).toEqual(["Please sign in again to upload"]);
  });

  it("uploads a QR card without sharing it and names the failure", async () => {
    function extract(name: string): string {
      const start = html.indexOf("function " + name);
      const brace = html.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
          depth--;
          if (depth === 0) return html.slice(start, i + 1);
        }
      }
      throw new Error("could not extract " + name);
    }
    const saveStart = html.indexOf("function schediManagedTenantId");
    const saveEnd = html.indexOf("window.schediQrDownload = async function");
    const source = extract("schediQrStoredUrl") + "\n" + html.slice(saveStart, saveEnd);
    const toasts: { message: string; kind: string }[] = [];
    const posts: { purpose?: string }[] = [];
    const state = {
      pending: { blob: { type: "image/png" }, type: "image/png" } as { blob: { type: string }; type: string } | null,
      demo: false,
      tenant: { id: "axeldelcidphotography", qrUrl: "https://schedi.app/qr/axeldelcidphotography.png" } as { id: string; qrUrl?: string },
      result: { ok: true, status: 200, error: "", url: "https://schedi.app/qr/saved.png" },
      throwFetch: false,
    };
    const posted = new Function(
      "fetch",
      "localStorage",
      "showToast",
      "state",
      `var window = { get __SCHEDI_DEMO() { return state.demo; } };
       var schediQrPending = null;
       var platformState = { isAgencyMasterLoggedIn: false, ownerSelfSession: true, activeTenantId: "" };
       function getTenant() { return state.tenant; }
       function schediAuthSession() { return "owner-token"; }
       function schediAuthMeta() { return { role: "owner" }; }
       function blobToBase64() { return Promise.resolve("abc"); }
       function safeHttpsUrl(value) { return String(value || "").indexOf("https://") === 0 ? value : ""; }
       function saveState() { return Promise.resolve(); }
       function schediQrShowFilled() {}
       function schediQrDeliverFile() { throw new Error("save must not share or download"); }
       ${source}
       return function () { schediQrPending = state.pending; return window.schediQrSave(); };`,
    )(
      (async (_url: string, init?: RequestInit) => {
        if (state.throwFetch) throw new Error("offline");
        posts.push(JSON.parse(String(init?.body || "{}")));
        return {
          ok: state.result.ok,
          status: state.result.status,
          json: async () => ({ ok: state.result.ok, error: state.result.error, url: state.result.url }),
        };
      }) as unknown as typeof fetch,
      { getItem: () => "" },
      (message: string, kind: string) => { toasts.push({ message, kind }); },
      state,
    );
    await posted();
    expect(posts).toHaveLength(1);
    expect(posts[0].purpose).toBe("qr");
    expect(toasts).toEqual([{ message: "QR code saved.", kind: "success" }]);

    toasts.length = 0;
    posts.length = 0;
    state.pending = null;
    await posted();
    expect(posts).toHaveLength(0);
    expect(toasts).toEqual([{ message: "This QR code is already saved.", kind: "info" }]);

    toasts.length = 0;
    state.pending = { blob: { type: "image/png" }, type: "image/png" };
    state.result = { ok: false, status: 400, error: "too_large", url: "" };
    await posted();
    expect(toasts).toEqual([{ message: "That file is over 2 MB. Use a smaller QR image.", kind: "error" }]);

    toasts.length = 0;
    state.result = { ok: false, status: 403, error: "forbidden", url: "" };
    await posted();
    expect(toasts).toEqual([{ message: "That business is not on this account.", kind: "error" }]);

    toasts.length = 0;
    state.throwFetch = true;
    await posted();
    expect(toasts).toEqual([{ message: "Could not save that QR code. Check your connection and try again.", kind: "error" }]);

    toasts.length = 0;
    posts.length = 0;
    state.throwFetch = false;
    state.demo = true;
    await posted();
    expect(posts).toHaveLength(0);
    expect(toasts).toEqual([{ message: "Not saved in this demo. The preview stays on this screen only.", kind: "info" }]);
  });

  it("takes the card, modules, and badge from the brand or the logo", () => {
    function extract(name: string): string {
      const start = html.indexOf("function " + name);
      const brace = html.indexOf("{", start);
      let depth = 0;
      for (let i = brace; i < html.length; i++) {
        if (html[i] === "{") depth++;
        else if (html[i] === "}") {
          depth--;
          if (depth === 0) return html.slice(start, i + 1);
        }
      }
      throw new Error("could not extract " + name);
    }
    const names = [
      "schediQrHex",
      "schediQrRgb",
      "schediQrToHex",
      "schediQrChannel",
      "schediQrLuminance",
      "schediQrContrast",
      "schediQrContrastOnWhite",
      "schediQrDarkenForQuietZone",
      "schediQrRgbDistance",
      "schediQrAverageColor",
      "schediQrColorsFromPixels",
      "schediQrLogoPixels",
      "schediQrLogoColors",
      "schediQrSavedBrand",
      "schediQrPalette",
      "schediQrInk",
    ];
    const api = new Function(
      `${names.map(extract).join("\n")}
       return {
         schediQrColorsFromPixels,
         schediQrDarkenForQuietZone,
         schediQrContrastOnWhite,
         schediQrLuminance,
         schediQrPalette,
         schediQrSavedBrand,
         schediQrInk,
         schediQrLogoPixels,
         schediQrLogoColors
       };`,
    )() as {
      schediQrColorsFromPixels: (width: number, height: number, data: number[]) => { primary: string; secondary: string } | null;
      schediQrDarkenForQuietZone: (value: string) => string;
      schediQrContrastOnWhite: (value: string) => number;
      schediQrLuminance: (value: string) => number;
      schediQrPalette: (brand: string, colors: { primary?: string; secondary?: string } | null) => {
        background: string; background2: string; module: string; badge: string; branded: boolean;
      };
      schediQrSavedBrand: (tenant: { brandColor?: string; accentColor?: string; color?: string } | null) => string;
      schediQrInk: (background: string, background2?: string) => string;
      schediQrLogoPixels: (img: { naturalWidth?: number; naturalHeight?: number } | null) => { width: number; height: number; data: number[] } | null;
      schediQrLogoColors: (img: { naturalWidth?: number; naturalHeight?: number } | null) => { primary: string; secondary: string } | null;
    };
    const maroon = [0x7a, 0x1f, 0x3d];
    const navy = [0x1e, 0x3a, 0x5f];
    const width = 10;
    const height = 10;
    const data = new Array(width * height * 4).fill(0);
    function paint(x0: number, y0: number, x1: number, y1: number, rgb: number[], alpha = 255) {
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * 4;
          data[p] = rgb[0];
          data[p + 1] = rgb[1];
          data[p + 2] = rgb[2];
          data[p + 3] = alpha;
        }
      }
    }
    paint(0, 0, 10, 1, [255, 255, 255]);
    paint(0, 1, 5, 2, [0, 0, 0]);
    paint(5, 1, 10, 2, [250, 250, 250], 0);
    paint(0, 2, 10, 7, maroon);
    paint(0, 7, 10, 10, navy);
    const colors = api.schediQrColorsFromPixels(width, height, data);
    expect(colors).not.toBeNull();
    expect(colors?.primary).toBe("#7a1f3d");
    expect(colors?.secondary).toBe("#1e3a5f");
    expect(api.schediQrColorsFromPixels(2, 2, [255, 255, 255, 255, 0, 0, 0, 255, 250, 250, 252, 255, 1, 1, 1, 0])).toBeNull();
    const solid = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) {
      solid[i * 4] = 0x33;
      solid[i * 4 + 1] = 0x66;
      solid[i * 4 + 2] = 0x99;
      solid[i * 4 + 3] = 255;
    }
    expect(api.schediQrColorsFromPixels(2, 2, solid)).toEqual({ primary: "#336699", secondary: "" });
    const gradient = new Array(32 * 4);
    for (let x = 0; x < 32; x++) {
      const t = x / 31;
      gradient[x * 4] = Math.round(0x7a + (0x1e - 0x7a) * t);
      gradient[x * 4 + 1] = Math.round(0x1f + (0x3a - 0x1f) * t);
      gradient[x * 4 + 2] = Math.round(0x3d + (0x5f - 0x3d) * t);
      gradient[x * 4 + 3] = 255;
    }
    const ends = api.schediQrColorsFromPixels(32, 1, gradient);
    const channel = (hex: string, index: number) => parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
    const closeTo = (hex: string, rgb: number[]) => Math.abs(channel(hex, 0) - rgb[0]) <= 24 && Math.abs(channel(hex, 1) - rgb[1]) <= 24 && Math.abs(channel(hex, 2) - rgb[2]) <= 24;
    expect(ends && closeTo(ends.primary, maroon) || ends && closeTo(ends.secondary, maroon)).toBe(true);
    expect(ends && closeTo(ends.primary, navy) || ends && closeTo(ends.secondary, navy)).toBe(true);
    const gradientCard = api.schediQrPalette("", ends);
    expect(gradientCard.background).not.toBe(gradientCard.background2);
    expect(api.schediQrContrastOnWhite(gradientCard.module)).toBeGreaterThanOrEqual(4.5);
    expect(closeTo(gradientCard.module, navy)).toBe(true);

    expect(api.schediQrContrastOnWhite("#10b981")).toBeLessThan(4.5);
    const darkened = api.schediQrDarkenForQuietZone("#10b981");
    expect(api.schediQrContrastOnWhite(darkened)).toBeGreaterThanOrEqual(4.5);
    expect(api.schediQrLuminance(darkened)).toBeLessThan(api.schediQrLuminance("#10b981"));
    expect(api.schediQrDarkenForQuietZone("#1e3a5f")).toBe("#1e3a5f");
    expect(api.schediQrContrastOnWhite(api.schediQrDarkenForQuietZone("#ffffff"))).toBeGreaterThanOrEqual(4.5);
    expect(api.schediQrDarkenForQuietZone("not-a-color")).toBe("#000000");

    const fromLogo = api.schediQrPalette("", colors);
    expect(fromLogo.branded).toBe(true);
    expect(fromLogo.background).toBe("#7a1f3d");
    expect(fromLogo.background2).toBe("#1e3a5f");
    expect(fromLogo.badge).toBe("#7a1f3d");
    expect(fromLogo.module).toBe("#1e3a5f");
    const saved = api.schediQrPalette("#10b981", colors);
    expect(saved.background).toBe("#10b981");
    expect(saved.badge).toBe("#10b981");
    expect(saved.background2).toBe("#10b981");
    expect(saved.module).toBe(darkened);
    expect(api.schediQrPalette("", null)).toEqual({
      background: "#ffffff",
      background2: "#ffffff",
      module: "#000000",
      badge: "",
      branded: false,
    });
    expect(api.schediQrSavedBrand({ accentColor: "#abc", color: "#112233" })).toBe("#aabbcc");
    expect(api.schediQrSavedBrand({ brandColor: "#1e3a5f", accentColor: "#abcdef" })).toBe("#1e3a5f");
    expect(api.schediQrSavedBrand(null)).toBe("");
    expect(api.schediQrInk("#1e3a5f", "#7a1f3d")).toBe("#ffffff");
    expect(api.schediQrInk("#10b981", "#10b981")).toBe("#111111");

    const sampled = { data: solid };
    const reads: string[] = [];
    const documentStub = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return {
              clearRect() {},
              drawImage() { reads.push("draw"); },
              getImageData() {
                if (sampled.data === solid) return { data: solid };
                throw new Error("tainted");
              },
            };
          },
        };
      },
    };
    const pixels = new Function(
      "document",
      `${extract("schediQrLogoPixels")}
       return schediQrLogoPixels;`,
    )(documentStub) as (img: { naturalWidth: number; naturalHeight: number } | null) => { width: number; height: number; data: number[] } | null;
    expect(pixels(null)).toBeNull();
    const got = pixels({ naturalWidth: 200, naturalHeight: 100 });
    expect(got && got.width).toBe(96);
    expect(got && got.height).toBe(48);
    expect(got && got.data).toBe(solid);
    expect(reads).toEqual(["draw"]);
    sampled.data = [];
    expect(pixels({ naturalWidth: 20, naturalHeight: 20 })).toBeNull();
  });
});
