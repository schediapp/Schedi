import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const root = new URL("..", import.meta.url).pathname;
const chrome = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((path) => existsSync(path));
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

function bookingTemplate(source: string): string {
  const marker = "return `<!DOCTYPE html>";
  const start = source.indexOf(marker);
  const openTick = start + "return ".length;
  const end = source.indexOf("</html>`", openTick);
  return source.slice(openTick, end + "</html>`".length);
}

type Tone = { tone: "light" | "dark"; clear: boolean };
const toneFromPixels = new Function(`${extractFunction(html, "logoToneFromPixels")}; return logoToneFromPixels;`)() as (
  width: number, height: number, data: number[],
) => Tone | null;
const plateFor = new Function(`${extractFunction(html, "logoPlateFor")}; ${extractFunction(html, "logoBackdropChoice")}; return logoPlateFor;`)() as (
  tenant: { logoTone?: string; logoClear?: boolean; logoBackdrop?: string }, surface: string,
) => string;

function pixels(width: number, height: number, paint: (x: number, y: number) => [number, number, number, number]) {
  const data = new Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = paint(x, y);
      const i = (y * width + x) * 4;
      data[i] = px[0];
      data[i + 1] = px[1];
      data[i + 2] = px[2];
      data[i + 3] = px[3];
    }
  }
  return data;
}

function trackedEl(id: string) {
  const classes = new Set<string>();
  const el = {
    id,
    hidden: false,
    textContent: "",
    src: "",
    alt: "",
    value: "",
    checked: false,
    classList: {
      add(name: string) { classes.add(name); },
      remove(name: string) { classes.delete(name); },
      contains(name: string) { return classes.has(name); },
      toggle(name: string, force?: boolean) {
        const on = force == null ? !classes.has(name) : force;
        if (on) classes.add(name);
        else classes.delete(name);
        return on;
      },
    },
    removeAttribute(name: string) { if (name === "src") el.src = ""; },
  };
  return el;
}

function loadPainter() {
  const names = [
    "schediDashInitials",
    "schediLogoUrl",
    "logoToneFromPixels",
    "logoBackdropChoice",
    "logoPlateFor",
    "logoSurfaceTone",
    "applyLogoPlate",
    "measureLogoImage",
    "rememberLogoTone",
    "ensureLogoTone",
    "schediDashPlanLabel",
    "schediDashPaint",
    "paintClassicBannerLogo",
    "publicHttpsUrl",
    "bizInitials",
    "hideBizImage",
    "mapsHref",
    "paintBizHeader",
  ];
  const src = names.map((name) => extractFunction(html, name)).join("\n");
  const els: Record<string, ReturnType<typeof trackedEl>> = {};
  for (const id of ["schediDashUserLogo", "schediDashUserLogoPhone", "schediDashUserInitials", "schediDashUserInitialsPhone", "schediDashUserName", "schediDashUserPlan", "schediDashBizName", "tenantBannerLogo", "tenantBannerInitials", "pubHeaderLogo", "pubHeaderInitials", "bizLogo", "bizLogoInitials", "bizLogoWrap", "bizTitle", "bizIndustry", "bizAddress", "bizHours", "bizCoverWrap", "bizCover", "bizHeader"]) {
    els[id] = trackedEl(id);
  }
  let light = false;
  let newbook = false;
  const document = {
    get documentElement() {
      return {
        classList: {
          contains(name: string) {
            if (name === "schedi-light") return light;
            if (name === "schedi-newbook") return newbook;
            return false;
          },
        },
      };
    },
    getElementById(id: string) { return els[id] || null; },
    createElement() {
      return {
        width: 0,
        height: 0,
        getContext() {
          return {
            clearRect() {},
            drawImage() {},
            getImageData(_x: number, _y: number, w: number, h: number) {
              return { data: pixelBuffer(w, h) };
            },
          };
        },
      };
    },
  };
  let mode = "light-clear";
  function pixelBuffer(w: number, h: number) {
    return pixels(w, h, (x, y) => {
      if (mode === "opaque-light") return [255, 255, 255, 255];
      if (mode === "dark-clear") return x === 0 && y === 0 ? [8, 8, 8, 255] : [0, 0, 0, 0];
      return x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0];
    });
  }
  const fn = new Function(
    "document",
    "getTenant",
    "schediDashSetPage",
    "schediDashPage",
    "tenantData",
    `var window = { __logoToneScan: "" };
    var sessionStorage = { store: {}, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = v; } };
    function Image() { this.naturalWidth = 4; this.naturalHeight = 4; }
    Image.prototype = { set src(_value) { if (this.onload) this.onload(); } };
    function getPubLocation() { return ""; }
    function formatPublicHours() { return ""; }
    function renderSchediToday() {}
    ${src}
    return { schediDashPaint, paintClassicBannerLogo, paintBizHeader, ensureLogoTone, sessionStorage };`,
  );
  let tenant: Record<string, unknown> = {};
  const api = fn(document, () => tenant, () => {}, () => "today", null) as {
    schediDashPaint: () => void;
    paintClassicBannerLogo: (value: unknown) => void;
    paintBizHeader: () => void;
    ensureLogoTone: (value: unknown) => void;
    sessionStorage: { store: Record<string, string> };
  };
  return {
    els,
    api,
    setTenant(value: Record<string, unknown>) { tenant = value; },
    setTheme(nextLight: boolean, nextBook = false) { light = nextLight; newbook = nextBook; },
    setPixels(next: string) { mode = next; },
    paintBooking(value: Record<string, unknown>) {
      const booking = new Function(
        "document",
        "tenantData",
        `var window = { __logoToneScan: "" };
        var sessionStorage = { store: {}, getItem(k) { return this.store[k] || null; }, setItem(k, v) { this.store[k] = v; } };
        function Image() { this.naturalWidth = 4; this.naturalHeight = 4; }
        Image.prototype = { set src(_value) { if (this.onload) this.onload(); } };
        function getPubLocation() { return ""; }
        function formatPublicHours() { return ""; }
        ${src}
        paintBizHeader();`,
      );
      booking(document, value);
    },
  };
}

describe("logo contrast", () => {
  it("reads a light or dark tone from non-transparent pixels, weighted by alpha", () => {
    const light = toneFromPixels(4, 4, pixels(4, 4, (x, y) => x === 0 && y === 0 ? [255, 255, 255, 255] : [0, 0, 0, 0]));
    expect(light).toEqual({ tone: "light", clear: true });
    const dark = toneFromPixels(4, 4, pixels(4, 4, (x, y) => x === 0 && y === 0 ? [10, 10, 12, 255] : [0, 0, 0, 0]));
    expect(dark).toEqual({ tone: "dark", clear: true });
    const opaque = toneFromPixels(4, 4, pixels(4, 4, () => [250, 250, 250, 255]));
    expect(opaque).toEqual({ tone: "light", clear: false });
    const weighted = toneFromPixels(2, 1, pixels(2, 1, (x) => x === 0 ? [255, 255, 255, 255] : [0, 0, 0, 20]));
    expect(weighted?.tone).toBe("light");
  });

  it("plates a clear logo only when its tone matches the surface, and the override wins", () => {
    const lightClear = { logoTone: "light", logoClear: true };
    const darkClear = { logoTone: "dark", logoClear: true };
    expect(plateFor(lightClear, "light")).toBe("dark");
    expect(plateFor(lightClear, "dark")).toBe("");
    expect(plateFor(darkClear, "dark")).toBe("light");
    expect(plateFor(darkClear, "light")).toBe("");
    expect(plateFor({ logoTone: "light", logoClear: false }, "light")).toBe("");
    expect(plateFor({ ...lightClear, logoBackdrop: "light" }, "light")).toBe("light");
    expect(plateFor({ ...darkClear, logoBackdrop: "dark" }, "dark")).toBe("dark");
    expect(plateFor({ logoTone: "light", logoClear: false, logoBackdrop: "dark" }, "dark")).toBe("dark");
    expect(plateFor({}, "light")).toBe("");
  });

  it("puts a dark tile on a light header and a light tile on a dark header", () => {
    const view = loadPainter();
    const lightLogo = { name: "Aria Rose", logoUrl: LOGO, logo: LOGO, logoTone: "light", logoClear: true, logoToneFor: LOGO };
    view.setTheme(true, false);
    view.paintBooking(lightLogo);
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-dark")).toBe(true);
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-light")).toBe(false);
    expect(view.els.bizLogo.classList.contains("logo-plate-dark")).toBe(true);
    expect(view.els.pubHeaderLogo.src).toBe(LOGO);

    view.setTheme(true, true);
    view.paintBooking(lightLogo);
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-dark")).toBe(true);

    const darkLogo = { name: "Aria Rose", logoUrl: LOGO, logo: LOGO, logoTone: "dark", logoClear: true, logoToneFor: LOGO };
    view.setTheme(false, false);
    view.paintBooking(darkLogo);
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-light")).toBe(true);
    expect(view.els.bizLogo.classList.contains("logo-plate-light")).toBe(true);
    view.setTheme(false, true);
    view.paintBooking(darkLogo);
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-light")).toBe(true);

    view.setTenant(lightLogo);
    view.setTheme(true, false);
    view.api.schediDashPaint();
    view.api.paintClassicBannerLogo(lightLogo);
    for (const id of ["schediDashUserLogo", "schediDashUserLogoPhone", "tenantBannerLogo"] as const) {
      expect(view.els[id].classList.contains("logo-plate-dark"), id).toBe(true);
      expect(view.els[id].hidden, id).toBe(false);
    }

    const forced = { ...darkLogo, logoBackdrop: "dark" };
    view.setTheme(false, false);
    view.paintBooking(forced);
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-dark")).toBe(true);
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-light")).toBe(false);
    view.setTenant(forced);
    view.api.schediDashPaint();
    expect(view.els.schediDashUserLogo.classList.contains("logo-plate-dark")).toBe(true);
  });

  it("computes a tone for a legacy logo that has none, then caches it", () => {
    const view = loadPainter();
    view.setPixels("light-clear");
    view.setTheme(true, false);
    const legacy = { name: "Aria Rose", logoUrl: LOGO, logo: LOGO };
    view.setTenant(legacy);
    view.api.ensureLogoTone(legacy);
    expect(legacy).toMatchObject({ logoTone: "light", logoClear: true, logoToneFor: LOGO });
    expect(view.api.sessionStorage.store["schedi.logoTone." + LOGO]).toContain("light");
    view.api.schediDashPaint();
    expect(view.els.schediDashUserLogo.classList.contains("logo-plate-dark")).toBe(true);
    expect(view.els.schediDashUserLogoPhone.classList.contains("logo-plate-dark")).toBe(true);
    view.api.paintClassicBannerLogo(legacy);
    expect(view.els.tenantBannerLogo.classList.contains("logo-plate-dark")).toBe(true);

    view.setPixels("dark-clear");
    view.setTheme(false, true);
    const bookingLegacy = { name: "Aria Rose", logoUrl: LOGO, logo: LOGO };
    view.paintBooking(bookingLegacy);
    expect(bookingLegacy).toMatchObject({ logoTone: "dark", logoClear: true });
    expect(view.els.pubHeaderLogo.classList.contains("logo-plate-light")).toBe(true);
  });

  it("saves Auto, Light, or Dark with the business profile and previews both surfaces", () => {
    const formAt = html.indexOf("window.handleUpdateShiftsSubmit = function");
    const form = html.slice(formAt, formAt + 5000);
    expect(form).toContain("tenant.logoBackdrop = readLogoBackdrop()");
    expect(form.indexOf("tenant.logoBackdrop = readLogoBackdrop()")).toBeLessThan(form.indexOf("saveState()"));
    expect(html).toContain('id="logoBackdropAuto"');
    expect(html).toContain('id="logoBackdropLight"');
    expect(html).toContain('id="logoBackdropDark"');
    expect(html).toContain('id="logoToneLight"');
    expect(html).toContain('id="logoToneDark"');
    expect(html).toContain('value="auto" checked');
    expect(extractFunction(html, "logoBackdropChoice")).toContain("return 'auto'");
    const store = extractFunction(html, "storeLogoBlob");
    const saved = store.slice(store.indexOf("writeBusinessLogo(tenant, body.url)"));
    expect(saved).toContain("rememberLogoTone(tenant, measuredTone, body.url)");
    expect(saved.indexOf("rememberLogoTone(tenant, measuredTone, body.url)")).toBeLessThan(saved.indexOf("await saveState()"));
    const template = bookingTemplate(html);
    expect(template).toContain("function ensureLogoTone");
    expect(template).toContain("#0f172a");
    expect(template).toContain("logo-plate-light");
    expect(template).not.toContain(".pub-header-logo { object-fit: cover; display: block; background: #ffffff;");
    expect(template).toContain("html.schedi-newbook .pub-header-logo");
  });
});

describe.skipIf(!chrome)("logo contrast layout", () => {
  it("keeps the logo controls and booking header inside 390, 1280, and 1920", async () => {
    const server = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
      const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml" };
      const instance = createServer((req, res) => {
        const path = new URL(req.url || "/", "http://127.0.0.1").pathname;
        const file = path === "/" ? "/index.html" : path;
        const full = join(root, file);
        if (!full.startsWith(root) || !existsSync(full)) {
          res.writeHead(404);
          res.end("missing");
          return;
        }
        res.writeHead(200, { "content-type": types[extname(full)] || "application/octet-stream" });
        res.end(readFileSync(full));
      });
      instance.listen(0, "127.0.0.1", () => {
        const address = instance.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({
          port,
          close: () => new Promise((done, reject) => instance.close((error) => error ? reject(error) : done())),
        });
      });
    });
    const puppeteer = await import("puppeteer-core");
    const browser = await puppeteer.default.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
      for (const width of [390, 1280, 1920]) {
        await page.setViewport({ width, height: 900 });
        const fit = await page.evaluate(() => {
          const field = document.getElementById("logoBackdropField");
          let node: HTMLElement | null = field;
          while (node) {
            node.hidden = false;
            node.classList.remove("hidden");
            node.style.setProperty("display", "block", "important");
            node.style.setProperty("max-width", "100%", "important");
            node = node.parentElement;
          }
          document.documentElement.style.overflowX = "hidden";
          const box = field ? field.getBoundingClientRect() : null;
          const mark = document.getElementById("tenantBannerMark");
          const markBox = mark ? mark.getBoundingClientRect() : null;
          return {
            field: box ? { right: box.right, width: box.width, scroll: field!.scrollWidth, client: field!.clientWidth } : null,
            mark: markBox ? { right: markBox.right, width: markBox.width } : null,
            viewport: window.innerWidth,
          };
        });
        expect(fit.field, String(width)).toBeTruthy();
        expect(fit.field!.right, String(width)).toBeLessThanOrEqual(fit.viewport + 1);
        expect(fit.field!.scroll, String(width)).toBeLessThanOrEqual(fit.field!.client + 1);
        expect(fit.mark!.right, String(width)).toBeLessThanOrEqual(fit.viewport + 1);
      }

      const template = bookingTemplate(html);
      const styleStart = template.indexOf("<style>");
      const styleEnd = template.indexOf("</style>", styleStart);
      const bookingCss = template.slice(styleStart, styleEnd + "</style>".length).replace(/\$\{[^}]*\}/g, "");
      const booking = await browser.newPage();
      await booking.setContent(`<!DOCTYPE html><html class="schedi-light schedi-newbook"><head><style>body{margin:0}header,.biz-header{max-width:100%;box-sizing:border-box}</style>${bookingCss}</head><body>
        <header class="sticky top-0 z-40 glass-card border-b border-slate-800 px-4 py-2.5">
          <div class="max-w-4xl mx-auto flex flex-wrap items-center justify-between gap-2">
            <span class="inline-flex items-center shrink-0">
              <img id="pubHeaderLogo" class="pub-header-logo logo-plate-dark" alt="Logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
            </span>
          </div>
        </header>
        <section id="bizHeader" class="biz-header"><div class="biz-header-body"><div class="biz-logo-wrap"><img id="bizLogo" class="biz-logo logo-plate-dark" alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div><div class="min-w-0"><h1 class="biz-title">A very long business name that should wrap inside the header</h1></div></div></section>
      </body></html>`, { waitUntil: "domcontentloaded" });
      for (const width of [390, 1280, 1920]) {
        await booking.setViewport({ width, height: 900 });
        const fit = await booking.evaluate(() => {
          const header = document.querySelector("header") as HTMLElement;
          const logo = document.getElementById("pubHeaderLogo") as HTMLElement;
          const biz = document.getElementById("bizLogo") as HTMLElement;
          const doc = document.documentElement;
          return {
            page: doc.scrollWidth,
            viewport: window.innerWidth,
            header: header.scrollWidth,
            logoRight: logo.getBoundingClientRect().right,
            bizRight: biz.getBoundingClientRect().right,
            plate: getComputedStyle(logo).backgroundColor,
          };
        });
        expect(fit.page, String(width)).toBeLessThanOrEqual(fit.viewport + 1);
        expect(fit.header, String(width)).toBeLessThanOrEqual(fit.viewport + 1);
        expect(fit.logoRight, String(width)).toBeLessThanOrEqual(fit.viewport + 1);
        expect(fit.bizRight, String(width)).toBeLessThanOrEqual(fit.viewport + 1);
        expect(fit.plate).toBe("rgb(15, 23, 42)");
      }
    } finally {
      await browser.close();
      await server.close();
    }
  });
});
