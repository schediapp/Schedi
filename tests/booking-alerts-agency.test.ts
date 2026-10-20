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

const webStart = html.indexOf("/* Schedi owner booking alerts");
const webEnd = html.indexOf("/* Booking alert deep link.", webStart);
const webPush = html.slice(webStart, webEnd);
const nativePush = html.slice(html.indexOf("Schedi Android app"), webStart);

function memStore(initial: Record<string, string> = {}) {
  const bag = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (bag.has(key) ? bag.get(key)! : null),
    setItem: (key: string, value: string) => { bag.set(key, String(value)); },
    removeItem: (key: string) => { bag.delete(key); },
  };
}

function portalSession(opts: {
  session?: string;
  meta?: Record<string, string> | null;
  search?: string;
  managed?: string;
  platformState?: Record<string, unknown>;
}) {
  const local = memStore();
  if (opts.session) local.setItem("schedi.authSession", opts.session);
  if (opts.meta) local.setItem("schedi.authMeta", JSON.stringify(opts.meta));
  const session = memStore();
  if (opts.managed) session.setItem("schedi.hqManagedTenantId", opts.managed);
  const run = new Function(
    "localStorage",
    "sessionStorage",
    "location",
    "platformState",
    `${extractFunction(webPush, "owner")}\nreturn owner();`,
  );
  return run(local, session, { search: opts.search || "" }, opts.platformState) as { session: string; tenantId: string } | null;
}

describe("booking alerts for an HQ agency session", () => {
  it("shows the card and the agenda bell from the same session check", () => {
    expect(webPush).toContain("meta.role !== 'agency'");
    expect(webPush).toContain("schedi.hqManagedTenantId");
    expect(webPush).toContain("params.get('from') === 'hq'");
    expect(extractFunction(webPush, "state")).toContain("if (!o) return 'hidden'");
    const render = extractFunction(webPush, "render");
    expect(render).toContain("card.classList.toggle('hidden', st === 'hidden')");
    expect(render).toContain("btn.style.display = st === 'hidden' ? 'none' : 'inline-flex'");
    expect(nativePush).toContain("meta.role !== 'owner'");
  });

  it("keeps an owner session on that business", () => {
    expect(portalSession({
      session: "owner-token",
      meta: { role: "owner", tenantId: "harbor-demo" },
      managed: "someone-else",
      search: "?tenant=lumen&from=hq",
    })).toEqual({ session: "owner-token", tenantId: "harbor-demo" });
    expect(portalSession({ session: "owner-token", meta: { role: "owner" } })).toBeNull();
    expect(portalSession({ meta: { role: "owner", tenantId: "harbor-demo" } })).toBeNull();
    expect(portalSession({ session: "x", meta: { role: "staff", tenantId: "harbor-demo" } })).toBeNull();
  });

  it("uses the business an agency session is managing", () => {
    expect(portalSession({
      session: "agency-token",
      meta: { role: "agency", email: "hq@schedi.app" },
      search: "?tenant=axeldelcidphotography&from=hq",
      managed: "older-business",
    })).toEqual({ session: "agency-token", tenantId: "axeldelcidphotography" });

    expect(portalSession({
      session: "agency-token",
      meta: { role: "agency" },
      managed: "axeldelcidphotography",
      platformState: { activeTenantId: "aura-exec", isAgencyMasterLoggedIn: true, isTenantOwnerLoggedIn: false, ownerSelfSession: false },
    })).toEqual({ session: "agency-token", tenantId: "axeldelcidphotography" });

    expect(portalSession({
      session: "agency-token",
      meta: { role: "agency" },
      platformState: { activeTenantId: "lumen-studio", isAgencyMasterLoggedIn: true, isTenantOwnerLoggedIn: true, ownerSelfSession: false },
    })).toEqual({ session: "agency-token", tenantId: "lumen-studio" });
  });

  it("stays hidden when the agency session is not managing a business", () => {
    expect(portalSession({
      session: "agency-token",
      meta: { role: "agency" },
      platformState: { activeTenantId: "aura-exec", isAgencyMasterLoggedIn: true, isTenantOwnerLoggedIn: false, ownerSelfSession: false },
    })).toBeNull();
    expect(portalSession({
      session: "agency-token",
      meta: { role: "agency" },
      search: "?tenant=not a business&from=hq",
      managed: "../other",
    })).toBeNull();
    expect(portalSession({
      session: "agency-token",
      meta: { role: "agency" },
      search: "?tenant=lumen-studio",
    })).toBeNull();
  });
});
