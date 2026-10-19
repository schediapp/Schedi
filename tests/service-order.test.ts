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

type Svc = { id: number | string; name: string; sortOrder?: number; hidden?: boolean; inactive?: boolean; active?: boolean; enabled?: boolean; status?: string };

const api = new Function(
  `${extractFunction(html, "serviceOrderNumber")}
   ${extractFunction(html, "serviceIsInactive")}
   ${extractFunction(html, "orderedServices")}
   ${extractFunction(html, "stampServiceOrder")}
   ${extractFunction(html, "moveServiceInList")}
   ${extractFunction(html, "moveServiceBefore")}
   ${extractFunction(html, "serviceMoveState")}
   return { orderedServices, moveServiceInList, moveServiceBefore, serviceMoveState, serviceIsInactive };`,
)() as {
  orderedServices: (list: Svc[]) => Svc[];
  moveServiceInList: (list: Svc[], id: number | string, delta: number) => Svc[];
  moveServiceBefore: (list: Svc[], fromId: number | string, toId: number | string) => Svc[];
  serviceMoveState: (list: Svc[], id: number | string) => { index: number; count: number; up: boolean; down: boolean };
  serviceIsInactive: (svc: Svc) => boolean;
};

describe("service order", () => {
  it("reorders, stamps sortOrder, and persists through the profile save", () => {
    const services: Svc[] = [
      { id: 1, name: "Cut" },
      { id: 2, name: "Color", hidden: true },
      { id: 3, name: "Gloss", active: false },
    ];
    const moved = api.moveServiceInList(services, 3, -1);
    expect(moved.map((s) => s.name)).toEqual(["Cut", "Gloss", "Color"]);
    expect(moved.map((s) => s.sortOrder)).toEqual([0, 1, 2]);
    expect(moved[1].active).toBe(false);
    expect(moved[2].hidden).toBe(true);
    const saved = sanitizeProfile({ name: "Harbor Studio", services: moved }, "harbor");
    expect(saved && saved.services.map((s: Svc) => s.name)).toEqual(["Cut", "Gloss", "Color"]);
    expect(saved && saved.services.map((s: Svc) => s.sortOrder)).toEqual([0, 1, 2]);
    expect(saved && saved.services[2].hidden).toBe(true);
    expect(saved && saved.services[1].active).toBe(false);
    const scrambled = [saved!.services[2], saved!.services[0], saved!.services[1]];
    expect(api.orderedServices(scrambled).map((s) => s.name)).toEqual(["Cut", "Gloss", "Color"]);
    const dropped = api.moveServiceBefore(saved!.services, 1, 2);
    expect(dropped.map((s) => s.name)).toEqual(["Gloss", "Color", "Cut"]);
    expect(sanitizeService(dropped[0]).sortOrder).toBe(0);
  });

  it("keeps a legacy tenant with no saved order in its current order", () => {
    const legacy: Svc[] = [
      { id: 2, name: "Color" },
      { id: 1, name: "Cut", inactive: true },
      { id: 4, name: "Gloss" },
    ];
    expect(api.orderedServices(legacy).map((s) => s.name)).toEqual(["Color", "Cut", "Gloss"]);
    expect(api.orderedServices(legacy).every((s) => s.sortOrder == null)).toBe(true);
    const saved = sanitizeProfile({ services: legacy }, "legacy");
    expect(saved && saved.services.map((s: Svc) => s.name)).toEqual(["Color", "Cut", "Gloss"]);
    expect(saved && saved.services[0].sortOrder).toBeUndefined();
    expect(saved && saved.services[1].inactive).toBe(true);
    expect(api.serviceIsInactive(legacy[1])).toBe(true);
    expect(api.serviceIsInactive(legacy[0])).toBe(false);
  });

  it("disables move up on the first service and move down on the last", () => {
    const list: Svc[] = [
      { id: "a", name: "A" },
      { id: "b", name: "B", hidden: true },
      { id: "c", name: "C", status: "inactive" },
    ];
    expect(api.serviceMoveState(list, "a")).toEqual({ index: 0, count: 3, up: false, down: true });
    expect(api.serviceMoveState(list, "c")).toEqual({ index: 2, count: 3, up: true, down: false });
    expect(api.moveServiceInList(list, "a", -1).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(api.moveServiceInList(list, "c", 1).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(api.moveServiceInList(list, "a", -1)[0].sortOrder).toBeUndefined();
    const down = api.moveServiceInList(list, "a", 1);
    expect(down.map((s) => s.id)).toEqual(["b", "a", "c"]);
    expect(down[0].hidden).toBe(true);
    expect(down[2].status).toBe("inactive");
    expect(api.serviceMoveState(down, "b").up).toBe(false);
    expect(api.serviceMoveState(down, "c").down).toBe(false);
  });

  it("uses the saved order on the booking page and the owner service pickers", () => {
    const book = api.orderedServices([
      { id: 1, name: "Cut", sortOrder: 2 },
      { id: 2, name: "Color", sortOrder: 0, hidden: true },
      { id: 3, name: "Gloss", sortOrder: 1, enabled: false },
    ]);
    expect(book.map((s) => s.name)).toEqual(["Color", "Gloss", "Cut"]);
    expect(book[0].hidden).toBe(true);
    expect(book[1].enabled).toBe(false);
    const gen = extractFunction(html, "generateStandaloneHtmlForTenant");
    const sortAt = gen.indexOf("orderedServices(publicTenant.services)");
    const jsonAt = gen.indexOf("JSON.stringify(publicTenant)");
    expect(sortAt).toBeGreaterThan(-1);
    expect(jsonAt).toBeGreaterThan(sortAt);
    expect(gen).toContain("orderedServices(tenant.services).forEach");
    expect(extractFunction(html, "fillManualServiceSelect")).toContain("orderedServices(tenant && tenant.services)");
    const recurAt = html.indexOf("window.openOwnerRecurringModal = function");
    expect(html.slice(recurAt, recurAt + 1800)).toContain("orderedServices(tenant.services)");
    expect(extractFunction(html, "renderSvc")).toContain("tenantData.services.map");
    const render = extractFunction(html, "renderTenantServices");
    expect(render).toContain("sd-svc-grip");
    expect(render).toContain("⋮⋮");
    expect(render).toContain(">Move up</button>");
    expect(render).toContain(">Move down</button>");
    expect(render).toContain("move.up ? '' : ' disabled'");
    expect(render).toContain("move.down ? '' : ' disabled'");
    expect(render).toContain('class="sd-svc-actions flex gap-2"');
    const apply = extractFunction(html, "applyTenantServiceMove");
    expect(apply).toContain("showToast('Order saved', 'info')");
    expect(apply.indexOf("before === after")).toBeLessThan(apply.indexOf("saveState()"));
    const bind = extractFunction(html, "bindServiceReorder");
    const dragging = bind.slice(bind.indexOf("addEventListener('pointermove'"), bind.indexOf("addEventListener('pointerup'"));
    expect(dragging).not.toContain("saveState");
    expect(dragging).not.toContain("showToast");
    expect(bind).toContain("applyTenantServiceMove(drag.id, drag.over, 'before')");
    expect(html).toContain("#tenantPortalSection #tenantServicesGrid .sd-svc-grip");
    expect(html).toContain("#tenantPortalSection:not(.schedi-newdash) #tenantServicesGrid .sd-svc-more > summary");
    expect(html).toContain("html.schedi-light #tenantPortalSection #tenantServicesGrid .sd-svc-grip");
    expect(html).toContain("#tenantPortalSection #tenantServicesGrid .sd-svc-moves { display: flex; }");
  });
});
