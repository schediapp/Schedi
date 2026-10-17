import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function extractFunction(source: string, name: string): string {
  let start = source.indexOf("function " + name);
  if (start >= 6 && source.slice(start - 6, start) === "async ") start -= 6;
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

function dashCss(source: string): string {
  const start = source.indexOf("/* schedi-newdash:");
  const end = source.indexOf("</style>", start);
  return source.slice(start, end);
}

const selection = new Function(
  `${extractFunction(html, "rosterBulkSelection")}; return rosterBulkSelection;`,
)() as (visible: string[], selected: Record<string, boolean>, action: string | { toggle: string } | null) => {
  selected: Record<string, boolean>;
  count: number;
  allChecked: boolean;
  indeterminate: boolean;
};

const confirmText = new Function(
  `${extractFunction(html, "rosterBulkDeleteConfirmText")}; return rosterBulkDeleteConfirmText;`,
)() as (n: number) => { title: string; body: string };

const toastText = new Function(
  `${extractFunction(html, "rosterBulkDeleteToast")}; return rosterBulkDeleteToast;`,
)() as (deleted: number, failed: number) => string;

describe("roster bulk delete", () => {
  it("select all only changes the rows currently shown", () => {
    const hidden = selection(["HB-1", "HB-2"], { "HB-9": true }, "all");
    expect(hidden.selected).toEqual({ "HB-9": true, "HB-1": true, "HB-2": true });
    expect(hidden.allChecked).toBe(true);
    const cleared = selection(["HB-1", "HB-2"], hidden.selected, "none");
    expect(cleared.selected).toEqual({ "HB-9": true });
    expect(cleared.allChecked).toBe(false);
    expect(cleared.indeterminate).toBe(false);
    const some = selection(["HB-1", "HB-2", "HB-3"], { "HB-2": true }, null);
    expect(some.indeterminate).toBe(true);
    expect(some.count).toBe(1);
  });

  it("asks once with the bulk confirmation and names partial failures in one toast", () => {
    expect(confirmText(3)).toEqual({ title: "Delete 3 appointments?", body: "This can't be undone." });
    expect(confirmText(1)).toEqual({ title: "Delete 1 appointment?", body: "This can't be undone." });
    const open = html.slice(html.indexOf("window.openRosterBulkDelete"), html.indexOf("window.confirmRosterDeleteFromModal"));
    expect(open).toContain("copy.title");
    expect(open).toContain("copy.body");
    const search = extractFunction(html, "renderRosterSearchResults");
    expect(search).toContain("rosterSearchListCoversSelectAll()");
    expect(toastText(3, 0)).toBe("Deleted 3 appointments.");
    expect(toastText(2, 1)).toBe("Deleted 2 appointments. 1 failed.");
    expect(toastText(0, 2)).toBe("Deleted 0 appointments. 2 failed.");
  });

  it("deletes through the same worker call, then one save, and does not email the client", () => {
    const server = extractFunction(html, "deleteRosterBookingOnServer");
    const bulk = extractFunction(html, "deleteRosterAppointments");
    expect(server).toContain("action: 'delete'");
    expect(server).toContain("bookingId: appId");
    expect(server).toContain("rememberRosterRevision(tenant, data)");
    expect(server).not.toContain("sendClient");
    expect(bulk).toContain("deleteRosterBookingOnServer(tenant, appId)");
    expect(bulk.match(/saveState\(/g)).toHaveLength(1);
    expect(bulk).toContain("saveState({ quietSyncErrors: true })");
    expect(bulk).not.toContain("sendClientCancellationEmail");
    expect(bulk).not.toContain("sendClientDecisionEmail");
    expect(bulk).not.toContain("window.confirm");
    const single = html.slice(html.indexOf("window.confirmRosterDeleteAppointment"), html.indexOf("async function deleteRosterAppointments"));
    expect(single).toContain("deleteRosterBookingOnServer(tenant, appId)");
    expect(single).toContain("await saveState()");
    expect(single).not.toContain("sendClient");
  });

  it("refreshes the roster revision between sequential deletes and saves once", async () => {
    const tenant = {
      id: "harbor",
      _rosterRevision: 4,
      appointments: [
        { id: "HB-1" },
        { id: "HB-2" },
        { id: "HB-3" },
      ],
    };
    const seenRevisions: number[] = [];
    const sandbox = {
      rosterSelectedIds: { "HB-1": true, "HB-2": true, "HB-3": true } as Record<string, boolean>,
      saves: [] as unknown[],
      async deleteRosterBookingOnServer(row: { _rosterRevision: number; appointments: { id: string }[] }, appId: string) {
        seenRevisions.push(row._rosterRevision);
        if (appId === "HB-2") return { ok: false };
        row._rosterRevision += 1;
        return { ok: true, data: { rosterRevision: row._rosterRevision } };
      },
      async saveState(opts: unknown) {
        sandbox.saves.push(opts);
        return { ok: true };
      },
    };
    const result = await runInNewContext(
      `(async () => { ${extractFunction(html, "deleteRosterAppointments")}\nreturn deleteRosterAppointments(tenant, ['HB-1', 'HB-2', 'HB-9']); })()`,
      { ...sandbox, tenant },
    ) as { deleted: number; failed: number };
    expect(result).toEqual({ deleted: 1, failed: 2 });
    expect(seenRevisions).toEqual([4, 5]);
    expect(tenant._rosterRevision).toBe(5);
    expect(tenant.appointments.map((row) => row.id)).toEqual(["HB-2", "HB-3"]);
    expect(sandbox.saves).toEqual([{ quietSyncErrors: true }]);
    expect(sandbox.rosterSelectedIds["HB-1"]).toBeUndefined();
    expect(sandbox.rosterSelectedIds["HB-2"]).toBe(true);
  });

  it("puts checkboxes on the list only, with a phone action bar", () => {
    expect(html).toContain('id="rosterSelectAll"');
    expect(html).toContain('aria-label="Select all"');
    expect(html).toContain('class="roster-select"');
    expect(html).toContain('id="rosterBulkBar"');
    expect(html).toContain("Delete selected");
    expect(html).toContain('colspan="8"');
    const calendar = extractFunction(html, "renderRosterCalendar");
    expect(calendar).not.toContain("roster-select");
    expect(calendar).not.toContain("rosterSelectAll");
    const css = dashCss(html);
    expect(css).toContain("bottom: calc(96px + env(safe-area-inset-bottom))");
    expect(css).toContain("html.schedi-light body.schedi-newdash .sd-bulk");
    expect(css).toContain("min-height: 44px");
    expect(css).toContain("body.schedi-newdash .sd-bulk-count");
    expect(css).toContain("td.roster-cell-check");
    expect(css).toContain("flex: 0 0 44px");
    expect(css).toContain("td.roster-cell-ref");
    expect(css).toContain(".sd-roster-all");
    expect(css).toContain("padding-left: 2px");
    expect(css).toContain(".sd-roster-results { left: 0; right: 0; width: auto; max-width: 100%; box-sizing: border-box; }");
    expect(css).not.toContain("100vw - 28px");
  });
});
