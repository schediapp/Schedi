import { describe, expect, it } from "vitest";
import { publicOrigin, redirectTo } from "../src/lib/http";
import { formatConnectEnableError } from "../src/lib/stripe-error";

describe("public redirects", () => {
  it("keeps portal errors on the Railway hostname when Next reports localhost", () => {
    const previous = process.env.RAILWAY_PUBLIC_DOMAIN;
    process.env.RAILWAY_PUBLIC_DOMAIN = "schedi-connect-production.up.railway.app";
    try {
      const request = new Request("https://localhost:8080/api/connect/enable", { method: "POST" });
      expect(publicOrigin(request)).toBe("https://schedi-connect-production.up.railway.app");
      const response = redirectTo(request, "/portal", {
        error: "Stripe could not create the connected account",
        code: "more_permissions_required",
        source: "connect",
      });
      expect(response.status).toBe(303);
      const location = response.headers.get("location");
      expect(location?.startsWith("https://schedi-connect-production.up.railway.app/portal?")).toBe(true);
      const url = new URL(location!);
      expect(url.searchParams.get("error")).toBe("Stripe could not create the connected account");
      expect(url.searchParams.get("code")).toBe("more_permissions_required");
      expect(url.searchParams.get("source")).toBe("connect");
      expect(url.hostname).not.toBe("localhost");
    } finally {
      if (previous === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN;
      else process.env.RAILWAY_PUBLIC_DOMAIN = previous;
    }
  });

  it("uses the request origin for local development", () => {
    const previous = process.env.RAILWAY_PUBLIC_DOMAIN;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    try {
      const request = new Request("http://localhost:3000/api/connect/enable", { method: "POST" });
      expect(publicOrigin(request)).toBe("http://localhost:3000");
    } finally {
      if (previous === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN;
      else process.env.RAILWAY_PUBLIC_DOMAIN = previous;
    }
  });
});

describe("connect enable errors", () => {
  it("logs Stripe type, message, and code without the secret key", () => {
    const error = Object.assign(
      new Error("The provided key rk_live_secretvalue does not have the required permissions for this endpoint."),
      {
        type: "StripePermissionError",
        rawType: "invalid_request_error",
        code: "more_permissions_required",
        requestId: "req_test",
      },
    );
    const failure = formatConnectEnableError(error);
    expect(failure.log).toEqual({
      type: "invalid_request_error",
      message: "The provided key rk_live_… does not have the required permissions for this endpoint.",
      code: "more_permissions_required",
    });
    expect(failure.message).toContain("more_permissions_required");
    expect(failure.message).toContain("v2_account_storer_write");
    expect(failure.message).not.toContain("rk_live_secretvalue");
    expect(failure.code).toBe("more_permissions_required");
  });

  it("keeps a local Schedi error as the banner text", () => {
    const failure = formatConnectEnableError(new Error("Card payments are available on an active Pro subscription."));
    expect(failure.log).toBeNull();
    expect(failure.message).toBe("Card payments are available on an active Pro subscription.");
  });
});
