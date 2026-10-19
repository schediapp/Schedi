import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { handleLogoGet, handleLogoUpload, sanitizeLogoSvg, sniffLogo } from "../workers/schedi-email-worker/src/logo-upload.js";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function deps(session: unknown) {
  return {
    json,
    isAllowedOrigin: () => true,
    readSession: async () => session,
  };
}

function post(data: string, origin = "https://schedi.app") {
  return new Request("https://schedi.app/api/logo-upload", {
    method: "POST",
    headers: origin ? { Origin: origin } : {},
    body: JSON.stringify({ session: "tok", data }),
  });
}

const owner = { role: "owner", tenantId: "harbor-demo" };

describe("logo upload", () => {
  it("keeps a plain SVG and rejects scripts, handlers, and remote links", () => {
    const clean = sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10z" fill="#111"/></svg>');
    expect(clean.ok).toBe(true);
    if (clean.ok) expect(clean.svg).toContain("<path");
    expect(sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').ok).toBe(false);
    expect(sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>').ok).toBe(false);
    expect(sanitizeLogoSvg('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a.png"/></svg>').ok).toBe(false);
    expect(sanitizeLogoSvg("<div>nope</div>").ok).toBe(false);
  });

  it("recognizes PNG bytes and rejects a renamed text file", () => {
    const png = Uint8Array.from(Buffer.from(TINY_PNG, "base64"));
    expect(sniffLogo(png)).toBe("image/png");
    expect(sniffLogo(new TextEncoder().encode("<html></html>"))).toBe("");
  });

  it("requires an owner session and a configured bucket", async () => {
    const denied = await handleLogoUpload(post(TINY_PNG), {}, "https://schedi.app", deps(null));
    expect(denied.status).toBe(401);
    const unconfigured = await handleLogoUpload(post(TINY_PNG), {}, "https://schedi.app", deps(owner));
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ error: "logo_storage_unconfigured" });
    const foreign = await handleLogoUpload(post(TINY_PNG), { LOGO_BUCKET: { put: async () => {} }, LOGO_PUBLIC_BASE: "https://logos.example.test" }, "https://schedi.app", deps({ role: "agency", tenantId: "hq" }));
    expect(foreign.status).toBe(401);
  });

  it("stores a PNG and returns the public URL for that business", async () => {
    const puts: { key: string; type: string }[] = [];
    const env = {
      LOGO_PUBLIC_BASE: "https://logos.example.test/",
      LOGO_BUCKET: {
        async put(key: string, _body: unknown, opts: { httpMetadata: { contentType: string } }) {
          puts.push({ key, type: opts.httpMetadata.contentType });
        },
        async delete() {},
      },
    };
    const res = await handleLogoUpload(post(TINY_PNG), env, "https://schedi.app", deps(owner));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; url: string };
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/^https:\/\/schedi\.app\/logos\/harbor-demo\?v=[a-f0-9]{18}$/);
    expect(puts).toEqual([{ key: "logos/harbor-demo.png", type: "image/png" }]);
  });

  it("stores a service image beside the business logo", async () => {
    const puts: string[] = [];
    const deleted: string[] = [];
    const env = {
      LOGO_PUBLIC_BASE: "https://logos.example.test",
      LOGO_BUCKET: {
        async put(key: string) { puts.push(key); },
        async delete(key: string) { deleted.push(key); },
      },
    };
    const req = new Request("https://schedi.app/api/logo-upload", {
      method: "POST",
      headers: { Origin: "https://schedi.app" },
      body: JSON.stringify({ session: "tok", data: TINY_PNG, serviceId: "svc-3" }),
    });
    const res = await handleLogoUpload(req, env, "https://schedi.app", deps(owner));
    expect(res.status).toBe(200);
    expect((await res.json() as { url: string }).url).toMatch(/^https:\/\/schedi\.app\/logos\/harbor-demo\/services\/svc-3\?v=[a-f0-9]{18}$/);
    expect(puts).toEqual(["logos/harbor-demo/services/svc-3.png"]);
    expect(deleted).not.toContain("logos/harbor-demo.png");
    expect(deleted).toEqual([
      "logos/harbor-demo/services/svc-3.jpg",
      "logos/harbor-demo/services/svc-3.webp",
      "logos/harbor-demo/services/svc-3.svg",
    ]);
    const bad = new Request("https://schedi.app/api/logo-upload", {
      method: "POST",
      headers: { Origin: "https://schedi.app" },
      body: JSON.stringify({ session: "tok", data: TINY_PNG, serviceId: "../logo" }),
    });
    const rejected = await handleLogoUpload(bad, env, "https://schedi.app", deps(owner));
    expect(rejected.status).toBe(400);
    expect(puts).toEqual(["logos/harbor-demo/services/svc-3.png"]);
  });

  it("stores a booking QR beside the logo and leaves the logo file alone", async () => {
    const puts: string[] = [];
    const deleted: string[] = [];
    const env = {
      LOGO_PUBLIC_BASE: "https://logos.example.test",
      LOGO_BUCKET: {
        async put(key: string) { puts.push(key); },
        async delete(key: string) { deleted.push(key); },
      },
    };
    const req = new Request("https://schedi.app/api/logo-upload", {
      method: "POST",
      headers: { Origin: "https://schedi.app" },
      body: JSON.stringify({ session: "tok", data: TINY_PNG, purpose: "qr" }),
    });
    const res = await handleLogoUpload(req, env, "https://schedi.app", deps(owner));
    expect(res.status).toBe(200);
    expect((await res.json() as { url: string }).url).toMatch(/^https:\/\/schedi\.app\/logos\/harbor-demo\/qr\?v=[a-f0-9]{18}$/);
    expect(puts).toEqual(["logos/harbor-demo/qr.png"]);
    expect(deleted).toEqual(["logos/harbor-demo/qr.jpg", "logos/harbor-demo/qr.webp", "logos/harbor-demo/qr.svg"]);
    expect(deleted.join(" ")).not.toContain("logos/harbor-demo.png");
    const webp = new Request("https://schedi.app/api/logo-upload", {
      method: "POST",
      headers: { Origin: "https://schedi.app" },
      body: JSON.stringify({ session: "tok", data: TINY_PNG, purpose: "poster" }),
    });
    expect((await handleLogoUpload(webp, env, "https://schedi.app", deps(owner))).status).toBe(400);
  });

  it("crops to a square no wider than 512 and the demo does not upload", () => {
    const crop = new Function(`${extractFunction(html, "logoCropSource")}; return logoCropSource;`)() as (
      w: number, h: number, stage: number, zoom: number, x: number, y: number,
    ) => { out: number; sw: number };
    const wide = crop(1000, 400, 280, 1, -200, 0);
    expect(wide.out).toBeLessThanOrEqual(512);
    expect(wide.sw).toBeGreaterThan(0);
    const store = extractFunction(html, "storeLogoBlob");
    expect(store.indexOf("__SCHEDI_DEMO")).toBeLessThan(store.indexOf("api/business-logo"));
    expect(extractFunction(html, "logoUploadMessage")).toContain("This demo shows your logo here only");
    expect(html).toContain('id="bizLogoInitials"');
    expect(html).toContain('id="pubHeaderLogo"');
    expect(html).toContain("schediDashLogoFailed");
    expect(html).toContain('id="tenantBannerInitials"');
    expect(html).toContain("Preview ready");
    expect(html).toContain('id="logoUploadDrop"');
    expect(html).toContain('id="logoCropCanvas"');
    expect(html).toContain("Or paste a link");
  });

  it("zooms around the center of the crop frame and saves that same square", () => {
    const source = new Function(`${extractFunction(html, "logoCropSource")}; return logoCropSource;`)() as (
      w: number, h: number, stage: number, zoom: number, x: number, y: number,
    ) => { sx: number; sy: number; sw: number; ox: number; oy: number; scale: number };
    const apply = new Function(`${extractFunction(html, "logoCropApplyZoom")}; return logoCropApplyZoom;`)() as (
      state: { zoom: number; ox: number; oy: number }, zoom: number, stage: number,
    ) => { zoom: number; ox: number; oy: number };
    const stage = 280;
    const fitScale = stage / 400;
    const fitted = source(1000, 400, stage, 1, (stage - 1000 * fitScale) / 2, (stage - 400 * fitScale) / 2);
    const wide = { zoom: 1, ox: fitted.ox, oy: fitted.oy };
    const before = { x: (stage / 2 - fitted.ox) / fitted.scale, y: (stage / 2 - fitted.oy) / fitted.scale };
    apply(wide, 2, stage);
    const drawn = source(1000, 400, stage, wide.zoom, wide.ox, wide.oy);
    expect((stage / 2 - drawn.ox) / drawn.scale).toBeCloseTo(before.x, 4);
    expect((stage / 2 - drawn.oy) / drawn.scale).toBeCloseTo(before.y, 4);
    expect(drawn.sx).toBeGreaterThan(fitted.sx);
    expect(drawn.sw).toBeCloseTo(stage / drawn.scale, 4);

    const squareState = { zoom: 1, ox: 0, oy: 0 };
    apply(squareState, 2, stage);
    const square = source(800, 800, stage, squareState.zoom, squareState.ox, squareState.oy);
    expect(square.ox).toBeLessThan(0);
    expect(square.oy).toBeLessThan(0);
    expect((stage / 2 - square.ox) / square.scale).toBeCloseTo(400, 4);
    expect((stage / 2 - square.oy) / square.scale).toBeCloseTo(400, 4);
  });

  it("keys the file to the signed-in business, replaces it, and removes only that logo", async () => {
    const objects = new Map<string, { bytes: Uint8Array; type: string }>();
    const env = {
      LOGO_BUCKET: {
        async put(key: string, body: Uint8Array, opts: { httpMetadata: { contentType: string } }) {
          objects.set(key, { bytes: body, type: opts.httpMetadata.contentType });
        },
        async get(key: string) {
          const hit = objects.get(key);
          return hit ? { body: hit.bytes, httpMetadata: { contentType: hit.type } } : null;
        },
        async delete(key: string) { objects.delete(key); },
      },
    };
    const claimed = new Request("https://schedi.app/api/business-logo", {
      method: "POST",
      headers: { Origin: "https://schedi.app" },
      body: JSON.stringify({ session: "tok", data: TINY_PNG, tenantId: "other-biz" }),
    });
    const first = await handleLogoUpload(claimed, env, "https://schedi.app", deps(owner));
    const firstBody = await first.json() as { url: string };
    expect(firstBody.url).toMatch(/^https:\/\/schedi\.app\/logos\/harbor-demo\?v=/);
    expect(objects.has("logos/harbor-demo.png")).toBe(true);
    expect(objects.has("logos/other-biz.png")).toBe(false);
    objects.set("logos/harbor-demo/services/svc-3.png", { bytes: new Uint8Array([1]), type: "image/png" });

    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44]);
    const jpegData = Buffer.from(jpeg).toString("base64");
    const secondReq = new Request("https://www.schedi.app/api/business-logo", {
      method: "POST",
      headers: { Origin: "https://www.schedi.app" },
      body: JSON.stringify({ session: "tok", data: jpegData }),
    });
    const second = await handleLogoUpload(secondReq, env, "https://www.schedi.app", deps(owner));
    const secondBody = await second.json() as { url: string };
    expect(secondBody.url).toMatch(/^https:\/\/schedi\.app\/logos\/harbor-demo\?v=[a-f0-9]{18}$/);
    expect(secondBody.url).not.toBe(firstBody.url);
    expect(objects.has("logos/harbor-demo.png")).toBe(false);
    expect(objects.has("logos/harbor-demo.jpg")).toBe(true);
    expect(objects.has("logos/harbor-demo/services/svc-3.png")).toBe(true);

    const version = new URL(secondBody.url).searchParams.get("v") || "";
    const served = await handleLogoGet(new Request(secondBody.url), env);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/jpeg");
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(jpeg);
    expect(version).toHaveLength(18);

    const stale = await handleLogoGet(new Request("https://schedi.app/logos/harbor-demo"), env);
    expect(stale.headers.get("cache-control")).toBe("public, max-age=60");

    const removed = await handleLogoUpload(new Request("https://schedi.app/api/business-logo", {
      method: "DELETE",
      headers: { Origin: "https://schedi.app" },
      body: JSON.stringify({ session: "tok", tenantId: "other-biz" }),
    }), env, "https://schedi.app", deps(owner));
    expect(removed.status).toBe(200);
    expect(objects.has("logos/harbor-demo.jpg")).toBe(false);
    expect(objects.has("logos/harbor-demo/services/svc-3.png")).toBe(true);
    const missing = await handleLogoGet(new Request("https://schedi.app/logos/harbor-demo?v=" + version), env);
    expect(missing.status).toBe(404);

    const unconfigured = await handleLogoGet(new Request("https://schedi.app/logos/harbor-demo"), {});
    expect(unconfigured.status).toBe(404);
  });

  it("rejects a script SVG and an external reference", async () => {
    const env = {
      LOGO_BUCKET: {
        async put() { throw new Error("should not store"); },
        async delete() {},
      },
    };
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', "utf8").toString("base64");
    const res = await handleLogoUpload(post(svg), env, "https://schedi.app", deps(owner));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "svg_rejected" });
  });

  it("keeps the cropped preview after Use this crop, and a failed save shows the error with Retry", async () => {
    const useClick = extractFunction(html, "bindLogoUpload");
    const cropHandler = useClick.slice(useClick.indexOf("logoCropUse"), useClick.indexOf("confirmLogoCrop()"));
    expect(cropHandler).toContain("preventDefault");
    expect(cropHandler).not.toContain("storeLogoBlob");
    expect(extractFunction(html, "confirmLogoCrop")).toContain("stageLogoPreview");
    const failed = extractFunction(html, "storeLogoBlob");
    const failure = failed.slice(failed.indexOf("if (!res.ok"), failed.indexOf("writeBusinessLogo(tenant, body.url)"));
    expect(failure).toContain("showLogoUploadFailure(body.error || '')");
    expect(failure).not.toContain("revokeLogoObjectUrl()");

    type Listener = (event: { preventDefault?: () => void }) => void;
    function node(id: string, hidden = false) {
      const classes = new Set<string>(hidden ? ["hidden"] : []);
      const listeners: Record<string, Listener[]> = {};
      const el = {
        id,
        hidden,
        textContent: "",
        src: "",
        value: "",
        width: id === "logoCropCanvas" ? 280 : 0,
        height: id === "logoCropCanvas" ? 280 : 0,
        parentNode: null as unknown,
        nextSibling: null as unknown,
        classList: {
          add(name: string) {
            classes.add(name);
            if (name === "hidden") el.hidden = true;
          },
          remove(name: string) {
            classes.delete(name);
            if (name === "hidden") el.hidden = false;
          },
          toggle(name: string, force?: boolean) {
            const on = force == null ? !classes.has(name) : force;
            if (on) this.add(name);
            else this.remove(name);
            return on;
          },
          contains(name: string) {
            return classes.has(name);
          },
        },
        removeAttribute(name: string) {
          if (name === "src") el.src = "";
        },
        addEventListener(type: string, fn: Listener) {
          (listeners[type] ||= []).push(fn);
        },
        dispatch(type: string, event: { preventDefault?: () => void }) {
          for (const fn of listeners[type] || []) fn(event);
        },
        getContext() {
          return { drawImage() {}, clearRect() {} };
        },
        getBoundingClientRect() {
          return { width: 280, height: 280 };
        },
      };
      return el;
    }

    const ids = [
      "logoUploadDrop",
      "logoUploadFile",
      "logoUploadChoose",
      "logoCropCanvas",
      "logoCropZoom",
      "logoCropPanel",
      "logoCropUse",
      "logoCropCancel",
      "logoUploadClear",
      "logoUploadPreview",
      "logoUploadNote",
      "logoUploadSave",
      "logoUploadRetry",
      "tenantLogoUrl",
    ];
    const els: Record<string, ReturnType<typeof node>> = {};
    for (const id of ids) {
      els[id] = node(id, id === "logoUploadPreview" || id === "logoUploadSave" || id === "logoUploadRetry" || id === "logoUploadClear");
    }
    els.logoUploadFile.value = "studio-logo.png";
    const document = {
      body: { appendChild() {} },
      getElementById(id: string) {
        return els[id] || null;
      },
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() {
            return { drawImage() {} };
          },
          toBlob(cb: (blob: Blob) => void, type?: string) {
            cb(new Blob([Uint8Array.from([1, 2, 3, 4])], { type: type || "image/png" }));
          },
        };
      },
    };
    let blobs = 0;
    const urlApi = {
      createObjectURL() {
        blobs += 1;
        return "blob:cropped-" + blobs;
      },
      revokeObjectURL() {},
    };
    const names = [
      "logoCropSource",
      "logoUploadMessage",
      "setLogoNote",
      "revokeLogoObjectUrl",
      "refreshLogoPreview",
      "setLogoActionVisible",
      "clearStagedLogo",
      "logoUploadIsService",
      "parkLogoCropPanel",
      "hideLogoCrop",
      "stageLogoPreview",
      "showLogoUploadFailure",
      "uploadStagedLogo",
      "confirmLogoCrop",
      "storeLogoBlob",
      "bindLogoUpload",
    ];
    const src = names.map((name) => {
      const asyncAt = html.indexOf("async function " + name);
      if (asyncAt >= 0) {
        const body = extractFunction(html, name);
        return "async " + body;
      }
      return extractFunction(html, name);
    }).join("\n");
    const load = new Function(
      "document",
      "URL",
      `var LOGO_MAX_BYTES = 2 * 1024 * 1024;
      var LOGO_STAGE = 280;
      var logoCropState = null;
      var logoObjectUrl = '';
      var logoPendingSvg = null;
      var logoPendingBlob = null;
      var logoPendingType = '';
      var logoUploadBound = false;
      var logoUploadTarget = { kind: 'logo' };
      var logoCropHome = null;
      var window = { __SCHEDI_DEMO: false };
      var localStorage = { getItem: function () { return ''; } };
      var logoUploadResult = { ok: false, status: 503, body: { ok: false, error: 'logo_storage_unconfigured' } };
      var logoUploadCalls = 0;
      var logoTenant = { id: 'aria', logoUrl: '', logo: '', services: [] };
      async function fetch() {
        logoUploadCalls += 1;
        return { ok: !!logoUploadResult.ok, status: logoUploadResult.status, json: async function () { return logoUploadResult.body; } };
      }
      async function blobToBase64() { return 'abc'; }
      function safeHttpsUrl(value) {
        var v = String(value || '').trim();
        return v.indexOf('https://') === 0 ? v : '';
      }
      function getTenant() { return logoTenant; }
      function writeBusinessLogo(tenant, url) {
        tenant.logoUrl = url;
        tenant.logo = url;
        var field = document.getElementById('tenantLogoUrl');
        if (field) field.value = url;
        return url;
      }
      function schediDashPaint() {}
      function paintClassicBannerLogo() {}
      function renderLivePreviewIframe() {}
      function saveState() { return Promise.resolve(); }
      ${src}
      return {
        bind: bindLogoUpload,
        setCrop: function (state) { logoCropState = state; },
        setResult: function (result) { logoUploadResult = result; },
        calls: function () { return logoUploadCalls; }
      };`,
    );
    const api = load(document, urlApi) as {
      bind: () => void;
      setCrop: (state: unknown) => void;
      setResult: (result: { ok: boolean; status: number; body: { ok: boolean; error?: string; url?: string } }) => void;
      calls: () => number;
    };
    api.setCrop({
      image: { naturalWidth: 800, naturalHeight: 600, src: "blob:original" },
      zoom: 1,
      ox: 0,
      oy: 0,
    });
    api.bind();
    const click = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    els.logoCropUse.dispatch("click", click);

    expect(click.defaultPrevented).toBe(true);
    expect(api.calls()).toBe(0);
    expect(els.logoUploadFile.value).toBe("studio-logo.png");
    expect(els.logoCropPanel.hidden).toBe(true);
    expect(els.logoUploadPreview.hidden).toBe(false);
    expect(els.logoUploadPreview.src).toBe("blob:cropped-1");
    expect(els.logoUploadSave.hidden).toBe(false);
    expect(els.logoUploadRetry.hidden).toBe(true);
    expect(els.logoUploadNote.textContent).toContain("Preview ready");

    async function flush() {
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    els.logoUploadSave.dispatch("click", { preventDefault() {} });
    await flush();
    expect(api.calls()).toBe(1);
    expect(els.logoUploadPreview.hidden).toBe(false);
    expect(els.logoUploadPreview.src).toBe("blob:cropped-1");
    expect(els.logoUploadNote.textContent).toContain("logo_storage_unconfigured");
    expect(els.logoUploadNote.textContent).toContain("Logo upload is not turned on yet");
    expect(els.logoUploadNote.classList.contains("is-warn")).toBe(true);
    expect(els.logoUploadRetry.hidden).toBe(false);
    expect(els.logoUploadSave.hidden).toBe(false);
    expect(els.logoCropPanel.hidden).toBe(true);

    api.setResult({ ok: false, status: 401, body: { ok: false, error: "session_required" } });
    els.logoUploadRetry.dispatch("click", { preventDefault() {} });
    await flush();
    expect(api.calls()).toBe(2);
    expect(els.logoUploadPreview.hidden).toBe(false);
    expect(els.logoUploadPreview.src).toBe("blob:cropped-1");
    expect(els.logoUploadNote.textContent).toContain("session_required");
    expect(els.logoUploadNote.textContent).toContain("Sign in again");
    expect(els.logoUploadRetry.hidden).toBe(false);

    api.setResult({
      ok: true,
      status: 200,
      body: { ok: true, url: "https://schedi.app/logos/aria-rose?v=abc123abc123abc123" },
    });
    els.logoUploadRetry.dispatch("click", { preventDefault() {} });
    await flush();
    expect(els.logoUploadPreview.hidden).toBe(false);
    expect(els.logoUploadPreview.src).toBe("https://schedi.app/logos/aria-rose?v=abc123abc123abc123");
    expect(els.logoUploadNote.textContent).toBe("Logo saved.");
    expect(els.logoUploadRetry.hidden).toBe(true);
    expect(els.logoUploadSave.hidden).toBe(true);
  });
});
