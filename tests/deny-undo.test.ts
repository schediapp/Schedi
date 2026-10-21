import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

type Entry = {
  token: string;
  appId: string;
  tenantId: string;
  snapshot: { status: string; deniedAt?: string };
  deniedAt: string;
  deadline: number;
  committed: boolean;
};

type UndoState = {
  entries: Entry[];
  pending: Entry[];
  latest: Entry | null;
  flipped: Entry[];
  undone: Entry | null;
};

const reduce = new Function(
  `${extractFunction(html, "schediDenyUndoReduce")}; return schediDenyUndoReduce;`,
)() as (state: { entries: Entry[] } | UndoState, action: Record<string, unknown>, now: number) => UndoState;

function queue(state: { entries: Entry[] } | UndoState, token: string, appId: string, now: number) {
  return reduce(state, {
    type: "queue",
    token,
    appId,
    tenantId: "harbor",
    snapshot: { status: "pending" },
    deniedAt: "2026-10-16T16:00:00.000Z",
    ms: 30000,
  }, now);
}

describe("deny undo queue", () => {
  it("keeps a denial pending until its deadline", () => {
    const queued = queue({ entries: [] }, "a", "HB-1", 1000);
    expect(queued.pending.map((row) => row.token)).toEqual(["a"]);
    expect(queued.latest && queued.latest.deadline).toBe(31000);
    expect(queued.flipped).toEqual([]);
    expect(queued.entries[0].committed).toBe(false);
    const early = reduce(queued, { type: "tick" }, 30999);
    expect(early.flipped).toEqual([]);
    expect(early.pending).toHaveLength(1);
    const due = reduce(queued, { type: "tick" }, 31000);
    expect(due.flipped.map((row) => row.token)).toEqual(["a"]);
    expect(due.pending).toEqual([]);
    expect(due.entries[0].committed).toBe(true);
    const again = reduce(due, { type: "resume" }, 99999);
    expect(again.flipped).toEqual([]);
  });

  it("undoes only the latest denial and restores its snapshot", () => {
    let state = queue({ entries: [] }, "a", "HB-1", 0);
    state = queue(state, "b", "HB-2", 0);
    const undone = reduce(state, { type: "undo" }, 10);
    expect(undone.undone && undone.undone.token).toBe("b");
    expect(undone.undone && undone.undone.appId).toBe("HB-2");
    expect(undone.undone && undone.undone.snapshot.status).toBe("pending");
    expect(undone.pending.map((row) => row.token)).toEqual(["a"]);
    expect(undone.latest && undone.latest.token).toBe("a");
    const named = reduce(state, { type: "undo", token: "a" }, 10);
    expect(named.undone && named.undone.token).toBe("a");
    expect(named.pending.map((row) => row.token)).toEqual(["b"]);
  });

  it("resumes an expired denial once and keeps one still inside the window", () => {
    const next = reduce({
      entries: [
        { token: "old", appId: "1", tenantId: "harbor", snapshot: { status: "pending" }, deniedAt: "d", deadline: 500, committed: false },
        { token: "live", appId: "2", tenantId: "harbor", snapshot: { status: "pending" }, deniedAt: "d", deadline: 5000, committed: false },
        { token: "sent", appId: "3", tenantId: "harbor", snapshot: { status: "pending" }, deniedAt: "d", deadline: 100, committed: true },
      ],
    }, { type: "resume" }, 1000);
    expect(next.flipped.map((row) => row.token)).toEqual(["old"]);
    expect(next.pending.map((row) => row.token)).toEqual(["live"]);
    expect(next.entries.find((row) => row.token === "sent")?.committed).toBe(true);
    const second = reduce(next, { type: "resume" }, 1000);
    expect(second.flipped).toEqual([]);
  });

  it("declines a pending or requested booking and leaves every other status", () => {
    const confirm = extractFunction(html, "confirmDenyAppointment");
    expect(confirm).toContain("schediAcceptableRequest(app, tenant)");
    expect(confirm).not.toContain("!== 'pending'");
    const opener = html.slice(html.indexOf("window.openDenyConfirmModal = function"), html.indexOf("window.closeDenyConfirmModal = function"));
    expect(opener).toContain("schediAcceptableRequest(app, tenant)");
    expect(opener).not.toContain("!== 'pending'");

    function decline(status: string, extra: Record<string, unknown> = {}) {
      const app: { id: string; status: string; deniedAt?: string; clientName: string; clientEmail: string; cancelled?: boolean } = {
        id: "HB-REQ",
        status,
        clientName: "Ada Lovelace",
        clientEmail: "ada@example.com",
        ...extra,
      };
      const tenant = { id: "harbor", appointments: [app] };
      const box = { closed: 0, wrote: false, queued: "" };
      const document = {
        getElementById(id: string) {
          if (id === "denyConfirmAppId") return { value: " HB-REQ " };
          if (id === "bookingDecisionModal") return { classList: { contains: () => true }, getAttribute: () => "" };
          return null;
        },
      };
      new Function(
        "document",
        "tenant",
        "box",
        `function getTenant() { return tenant; }
         function closeDenyConfirmModal() { box.closed += 1; }
         function schediDenyUndoBindHide() {}
         function schediDenyUndoBoot() {}
         var schediDenyUndoBooted = false;
         function schediDenyUndoToken() { return "tok"; }
         function schediDenyUndoWrite() { box.wrote = true; }
         function schediDenyUndoArm() {}
         function schediDenyUndoPaint() {}
         function renderTenantRoster() {}
         function renderLivePreviewIframe() {}
         function renderSchediToday() {}
         function rosterTodayIso() { return "2026-10-21"; }
         function schediNowMinutes() { return 12 * 60; }
         var SCHEDI_DENY_UNDO_MS = 30000;
         var schediDenyUndoState = { entries: [] };
         ${extractFunction(html, "schediDenyUndoReduce")}
         function schediDenyUndoApply(next) { schediDenyUndoState = next; box.queued = next.entries[0] && next.entries[0].snapshot.status; }
         ${extractFunction(html, "appointmentIsCancelled")}
         ${extractFunction(html, "schediWaitingRequest")}
         ${extractFunction(html, "schediAcceptableRequest")}
         ${extractFunction(html, "confirmDenyAppointment")}
         confirmDenyAppointment();
         box.status = tenant.appointments[0].status;
         box.deniedAt = tenant.appointments[0].deniedAt || "";`,
      )(document, tenant, box);
      return box;
    }

    for (const status of ["pending", "PENDING", "  Pending  ", "requested", "Requested", "  requested  "]) {
      const denied = decline(status);
      expect(denied.status).toBe("denied");
      expect(denied.deniedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(denied.queued).toBe(status);
      expect(denied.wrote).toBe(true);
      expect(denied.closed).toBe(1);
    }
    for (const status of ["", "   ", "accepted", "confirmed", "denied", "declined"]) {
      const kept = decline(status);
      expect(kept.status).toBe(status);
      expect(kept.deniedAt).toBe("");
      expect(kept.wrote).toBe(false);
      expect(kept.closed).toBe(1);
    }
    const cancelled = decline("pending", { cancelled: true });
    expect(cancelled.status).toBe("pending");
    expect(cancelled.wrote).toBe(false);
  });

  it("does not write or email from the confirm click", () => {
    const confirm = extractFunction(html, "confirmDenyAppointment");
    expect(confirm).not.toContain("saveState");
    expect(confirm).not.toContain("sendClientDecisionEmail");
    expect(confirm).toContain("type: 'queue'");
    expect(confirm).toContain("schediDenyUndoWrite()");
    const send = extractFunction(html, "schediDenyUndoSend");
    const writeAt = send.indexOf("schediDenyUndoWrite()");
    expect(send.indexOf("saveState({ quietSyncErrors: true })")).toBeGreaterThan(-1);
    expect(send.indexOf("sendClientDecisionEmail(tenant, app, false)")).toBeGreaterThan(-1);
    expect(send.indexOf("committed")).toBe(-1);
    expect(html).toContain("schediDenyUndoWrite();");
    expect(html.indexOf("schediDenyUndoApply(next);\n            schediDenyUndoWrite();")).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(send.indexOf("saveState({ quietSyncErrors: true })"));
    expect(html).toContain("schedi.denyUndo.v1");
    expect(html).toContain("Appointment denied");
    expect(html).toContain("pagehide");
    expect(html).toContain("a beacon racing the");
    const cancel = html.slice(html.indexOf("window.deleteAppointment = async function"), html.indexOf("window.openRosterDeleteModal"));
    expect(cancel).toContain("openOwnerConfirm");
    expect(cancel).not.toContain("window.confirm");
    expect(cancel).toContain("saveState()");
    expect(cancel).toContain("sendClientCancellationEmail");
    expect(cancel).not.toContain("schediDenyUndo");
  });
});
