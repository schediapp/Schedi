import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { patchRenameDeny } from "../scripts/patch-v132-rename-deny.mjs";

const FIXTURE = new URL("./fixtures/v132-auth-section.js", import.meta.url);
const SCRIPT = new URL("../scripts/patch-v132-rename-deny.mjs", import.meta.url);
const SANITIZED = "/home/ubuntu/.cursor/projects/agent-repos-Schedi/uploads/live-v132-index.sanitized_e157.js";
const SANITIZED_SHA = "f3d1a7b0d82fcc1c45d71d0a48f9302acc91bdce97445dd1e628dd8fa9b12b95";

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function runCli(input: string, expected: string) {
  const dir = mkdtempSync(join(tmpdir(), "schedi-rename-patch-"));
  const output = join(dir, "candidate.js");
  const manifest = join(dir, "manifest.json");
  const diff = join(dir, "diff.txt");
  execFileSync(process.execPath, [
    SCRIPT.pathname,
    "--input", input,
    "--output", output,
    "--expected-sha256", expected,
    "--manifest", manifest,
    "--diff", diff,
  ], { encoding: "utf8" });
  return { dir, output, manifest, diff };
}

function throwingKv() {
  const fail = () => {
    throw new Error("kv access");
  };
  return { get: fail, put: fail, delete: fail, list: fail };
}

function loadAuth(source: string) {
  const marker = '    if (path === "/auth" || path.startsWith("/auth/")) {';
  const dispatchAt = source.lastIndexOf(marker);
  const head = source.slice(0, dispatchAt);
  const dispatch = source.slice(dispatchAt);
  const context: Record<string, unknown> = { crypto, TextEncoder, TextDecoder, atob, btoa, URL, Response, Headers };
  vm.createContext(context);
  vm.runInContext(`
    function __name(fn) { return fn; }
    function json(body, status, origin) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    ${head}
    function authDispatch(request, env, origin, path) {
      ${dispatch}
    }
    globalThis.__loaded = {
      handleAuthRequest,
      renameOwnerSecret,
      workersDevAuthBlocked,
      isAllowedOrigin,
      corsHeaders,
      authDispatch,
    };
  `, context);
  return (context as { __loaded: {
    handleAuthRequest: Function;
    renameOwnerSecret: Function;
    workersDevAuthBlocked: (url: URL) => boolean;
    isAllowedOrigin: (origin: string) => boolean;
    corsHeaders: (origin: string) => Record<string, string>;
    authDispatch: Function;
  } }).__loaded;
}

describe("v132 rename byte patch", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("rejects a mismatched hash and patches only the two reviewed spans", () => {
    const input = readFileSync(FIXTURE);
    const wrong = runCliSafe(FIXTURE.pathname, "0".repeat(64));
    expect(wrong.status).not.toBe(0);
    const patched = runCli(FIXTURE.pathname, sha256(input));
    dirs.push(patched.dir);
    expect(statSync(patched.output).mode & 0o777).toBe(0o600);
    expect(statSync(patched.manifest).mode & 0o777).toBe(0o600);
    expect(statSync(patched.diff).mode & 0o777).toBe(0o600);
    const diff = readFileSync(patched.diff, "utf8");
    expect(diff).toContain('error: "rename_disabled"');
    expect(diff).not.toContain("[REDACTED");
    expect(diff).not.toContain("PRIVATE KEY");
    const manifest = JSON.parse(readFileSync(patched.manifest, "utf8"));
    expect(manifest.reverseRestoresInput).toBe(true);
    expect(manifest.spans.helper.oldLength).toBe(653);
    expect(manifest.spans.route.oldLength).toBe(730);
    expect(manifest.spans.helper.newLength).toBe(88);
    expect(manifest.spans.route.newLength).toBe(109);
    const output = readFileSync(patched.output);
    expect(output.subarray(0, manifest.unchanged.prefix.length).equals(input.subarray(0, manifest.unchanged.prefix.length))).toBe(true);
    const middleAt = manifest.spans.helper.offset + 88;
    expect(output.subarray(middleAt, middleAt + manifest.unchanged.middle.length).equals(
      input.subarray(manifest.spans.helper.offset + 653, manifest.spans.route.offset),
    )).toBe(true);
  });

  it("denies owner, agency, and anonymous rename with zero KV access and leaves other auth outcomes", async () => {
    const input = readFileSync(FIXTURE);
    const patched = runCli(FIXTURE.pathname, sha256(input));
    dirs.push(patched.dir);
    const source = readFileSync(patched.output, "utf8");
    expect(source.includes('if (path === "/auth/rename")')).toBe(true);
    const loaded = loadAuth(source);
    const kv = throwingKv();
    const env = { AUTH_KV: kv, AUTH_PEPPER: "pepper" };
    expect(await loaded.renameOwnerSecret()).toEqual({ ok: false, error: "rename_disabled" });
    async function post(path: string, body: string, session?: string) {
      return loaded.handleAuthRequest(new Request("https://schedi.app" + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }), env, "https://schedi.app", path, (payload: unknown, status: number) => new Response(JSON.stringify(payload), { status }), {});
    }
    for (const session of [undefined, "owner-token", "agency-token"]) {
      const response = await post("/auth/rename", JSON.stringify({
        session,
        fromId: "attacker-shop",
        toId: "harbor-cuts",
      }), session);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ ok: false, error: "rename_disabled" });
    }
    const malformed = await post("/auth/rename", "not-json");
    expect(malformed.status).toBe(403);
    const empty = await post("/auth/rename", "");
    expect(empty.status).toBe(403);
    const get = await loaded.handleAuthRequest(new Request("https://schedi.app/auth/rename"), env, "https://schedi.app", "/auth/rename", (payload: unknown, status: number) => new Response(JSON.stringify(payload), { status }), {});
    expect(get.status).toBe(405);
    const unconfigured = await loaded.handleAuthRequest(new Request("https://schedi.app/auth/rename", {
      method: "POST",
      body: "{}",
    }), {}, "https://schedi.app", "/auth/rename", (payload: unknown, status: number) => new Response(JSON.stringify(payload), { status }), {});
    expect(unconfigured.status).toBe(500);
    expect(await unconfigured.json()).toEqual({ ok: false, error: "auth_not_configured" });
    await expect(loaded.handleAuthRequest(new Request("https://schedi.app/auth/password", {
      method: "POST",
      body: JSON.stringify({ session: "owner-token", tenantId: "harbor-cuts", ownerEmail: "a@example.com", newPassword: "password1" }),
    }), env, "https://schedi.app", "/auth/password", (payload: unknown, status: number) => new Response(JSON.stringify(payload), { status }), {})).rejects.toThrow(/kv access/);

    const dispatch = source.slice(source.lastIndexOf('    if (path === "/auth" || path.startsWith("/auth/")) {'));
    const options = await loaded.authDispatch(new Request("https://schedi.app/auth/rename", { method: "OPTIONS" }), env, "https://schedi.app", "/auth/rename");
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-origin")).toBe("https://schedi.app");
    const foreign = await loaded.authDispatch(new Request("https://schedi.app/auth/rename", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example" },
    }), env, "https://evil.example", "/auth/rename");
    expect(foreign.status).toBe(403);
    expect(loaded.workersDevAuthBlocked(new URL("https://schedi-email-worker.workers.dev/auth/rename"))).toBe(true);
    expect(loaded.workersDevAuthBlocked(new URL("https://schedi.app/auth/rename"))).toBe(false);
    expect(input.includes(dispatch.trim().slice(0, 80))).toBe(true);
    expect(readFileSync(FIXTURE, "utf8").includes('function workersDevAuthBlocked(url) {')).toBe(true);
    expect(source.includes('function workersDevAuthBlocked(url) {')).toBe(true);
    expect(source.includes('if (path === "/billing" || path.startsWith("/billing/"))')).toBe(readFileSync(FIXTURE, "utf8").includes('if (path === "/billing" || path.startsWith("/billing/"))'));
  });
});

function runCliSafe(input: string, expected: string) {
  const dir = mkdtempSync(join(tmpdir(), "schedi-rename-patch-"));
  const output = join(dir, "candidate.js");
  try {
    execFileSync(process.execPath, [
      SCRIPT.pathname,
      "--input", input,
      "--output", output,
      "--expected-sha256", expected,
      "--manifest", join(dir, "manifest.json"),
      "--diff", join(dir, "diff.txt"),
    ], { encoding: "utf8" });
    return { status: 0, dir };
  } catch (error) {
    return { status: (error as { status?: number }).status ?? 1, dir };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("sanitized v132 module", () => {
  const present = existsSync(SANITIZED);
  it.skipIf(!present)("patches the sanitized module without moving any other bytes", () => {
    const input = readFileSync(SANITIZED);
    expect(sha256(input)).toBe(SANITIZED_SHA);
    const patched = runCli(SANITIZED, SANITIZED_SHA);
    const output = readFileSync(patched.output);
    const manifest = JSON.parse(readFileSync(patched.manifest, "utf8"));
    expect(manifest.input.sha256).toBe(SANITIZED_SHA);
    expect(output.subarray(0, manifest.unchanged.prefix.length).equals(input.subarray(0, manifest.unchanged.prefix.length))).toBe(true);
    const redacted = Buffer.from("[REDACTED-LONG-OPAQUE-LITERAL]");
    expect(input.includes(redacted)).toBe(true);
    expect(output.includes(redacted)).toBe(true);
    expect(readFileSync(patched.diff, "utf8").includes("[REDACTED")).toBe(false);
    rmSync(patched.dir, { recursive: true, force: true });
  });
});
