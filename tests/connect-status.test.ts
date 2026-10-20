import { describe, expect, it } from "vitest";
import { cardConnectStatus, cardConnectStatusLabel } from "../src/lib/connect-status";

describe("card account status", () => {
  it("stays not started until an account exists, then in progress until it can take charges", () => {
    expect(cardConnectStatus(false, false)).toBe("not_started");
    expect(cardConnectStatus(true, false)).toBe("in_progress");
    expect(cardConnectStatus(true, true)).toBe("ready");
    expect(cardConnectStatus(false, true)).toBe("ready");
    expect(cardConnectStatusLabel("not_started")).toBe("Not started");
    expect(cardConnectStatusLabel("in_progress")).toBe("In progress");
    expect(cardConnectStatusLabel("ready")).toBe("Ready");
  });
});
