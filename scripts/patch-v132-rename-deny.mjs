#!/usr/bin/env node
/**
 * Byte patch for live email-worker v132 index.js.
 * Replaces only the /auth/rename helper and its route branch.
 * Does not deploy, upload, or print module bytes.
 *
 * The parent passes the pristine module SHA256 as --expected-sha256:
 * 40e6b483af3b7077bca22f6f80db24be97e696fc66e9e28a7e2db6aeee0ce3bf
 * A sanitized test passes that file's own hash. There is no bypass flag.
 */
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

const HELPER_OLD = Buffer.from("YXN5bmMgZnVuY3Rpb24gcmVuYW1lT3duZXJTZWNyZXQoZW52LCBmcm9tSWQsIHRvSWQpIHsKICBjb25zdCBzb3VyY2UgPSBTdHJpbmcoZnJvbUlkIHx8ICIiKS50cmltKCk7CiAgY29uc3QgZGVzdCA9IFN0cmluZyh0b0lkIHx8ICIiKS50cmltKCk7CiAgaWYgKCFzb3VyY2UgfHwgIWRlc3QgfHwgc291cmNlID09PSBkZXN0KSByZXR1cm4geyBvazogdHJ1ZSB9OwogIGNvbnN0IHJlY29yZCA9IGF3YWl0IHJlYWRKc29uKGVudi5BVVRIX0tWLCAidGVuYW50OiIgKyBzb3VyY2UpOwogIGlmICghcmVjb3JkIHx8ICFyZWNvcmQuaGFzaCkgcmV0dXJuIHsgb2s6IHRydWUsIG1pc3Npbmc6IHRydWUgfTsKICByZWNvcmQudGVuYW50SWQgPSBkZXN0OwogIGF3YWl0IGVudi5BVVRIX0tWLnB1dCgidGVuYW50OiIgKyBkZXN0LCBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTsKICBhd2FpdCBlbnYuQVVUSF9LVi5kZWxldGUoInRlbmFudDoiICsgc291cmNlKTsKICBpZiAocmVjb3JkLmVtYWlsKSB7CiAgICBhd2FpdCByZW1vdmVUZW5hbnRGcm9tRW1haWxJbmRleChlbnYsIHJlY29yZC5lbWFpbCwgc291cmNlKTsKICAgIGF3YWl0IGFkZFRlbmFudFRvRW1haWxJbmRleChlbnYsIHJlY29yZC5lbWFpbCwgZGVzdCk7CiAgfQogIHJldHVybiB7IG9rOiB0cnVlIH07Cn0=", "base64");
const ROUTE_OLD = Buffer.from("ICBpZiAocGF0aCA9PT0gIi9hdXRoL3JlbmFtZSIpIHsKICAgIGNvbnN0IHNlc3Npb24gPSBhd2FpdCByZWFkU2Vzc2lvbihlbnYsIGJvZHkuc2Vzc2lvbik7CiAgICBpZiAoIXNlc3Npb24pIHJldHVybiBqc29uMih7IG9rOiBmYWxzZSwgZXJyb3I6ICJzZXNzaW9uX3JlcXVpcmVkIiB9LCA0MDEsIG9yaWdpbik7CiAgICBjb25zdCBmcm9tSWQgPSBTdHJpbmcoYm9keS5mcm9tSWQgfHwgIiIpLnRyaW0oKTsKICAgIGNvbnN0IHRvSWQgPSBTdHJpbmcoYm9keS50b0lkIHx8ICIiKS50cmltKCk7CiAgICBpZiAoc2Vzc2lvbi5yb2xlID09PSAib3duZXIiICYmIHNlc3Npb24udGVuYW50SWQgIT09IGZyb21JZCkgewogICAgICByZXR1cm4ganNvbjIoeyBvazogZmFsc2UsIGVycm9yOiAiZm9yYmlkZGVuIiB9LCA0MDMsIG9yaWdpbik7CiAgICB9CiAgICBpZiAoc2Vzc2lvbi5yb2xlICE9PSAib3duZXIiICYmIHNlc3Npb24ucm9sZSAhPT0gImFnZW5jeSIpIHsKICAgICAgcmV0dXJuIGpzb24yKHsgb2s6IGZhbHNlLCBlcnJvcjogImZvcmJpZGRlbiIgfSwgNDAzLCBvcmlnaW4pOwogICAgfQogICAgY29uc3QgcmVuYW1lZCA9IGF3YWl0IHJlbmFtZU93bmVyU2VjcmV0KGVudiwgZnJvbUlkLCB0b0lkKTsKICAgIGlmICghcmVuYW1lZC5vaykgcmV0dXJuIGpzb24yKHJlbmFtZWQsIDQwMCwgb3JpZ2luKTsKICAgIHJldHVybiBqc29uMih7IG9rOiB0cnVlIH0sIDIwMCwgb3JpZ2luKTsKICB9Cg==", "base64");
const HELPER_NEW = Buffer.from("YXN5bmMgZnVuY3Rpb24gcmVuYW1lT3duZXJTZWNyZXQoKSB7CiAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogInJlbmFtZV9kaXNhYmxlZCIgfTsKfQ==", "base64");
const ROUTE_NEW = Buffer.from("ICBpZiAocGF0aCA9PT0gIi9hdXRoL3JlbmFtZSIpIHsKICAgIHJldHVybiBqc29uMih7IG9rOiBmYWxzZSwgZXJyb3I6ICJyZW5hbWVfZGlzYWJsZWQiIH0sIDQwMywgb3JpZ2luKTsKICB9Cg==", "base64");
const HELPER_SHA = "e17b43ff595a67e795da38ae21b859b4ee93bd4d68eec5e46429610f5063f11d";
const ROUTE_SHA = "b4322352c7089ac2f04f679d462940b80c1205b214ab28eedd14a9ca3fc8c156";
const SCOPE_START = Buffer.from("async function handleAuthRequest(request, env, origin, path, json2, deps) {\n");
const SCOPE_END = Buffer.from("\n__name(handleAuthRequest, \"handleAuthRequest\");");
const NOT_FOUND = Buffer.from("  return json2({ ok: false, error: \"not_found\" }, 404, origin);\n");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function findAll(buf, needle) {
  const hits = [];
  let from = 0;
  while (from <= buf.length) {
    const at = buf.indexOf(needle, from);
    if (at < 0) break;
    hits.push(at);
    from = at + 1;
  }
  return hits;
}

function fail(message) {
  const error = new Error(message);
  error.statusCode = 1;
  throw error;
}

export function patchRenameDeny(input) {
  if (!Buffer.isBuffer(input)) fail("input must be a buffer");
  if (input.includes(13)) fail("input contains CR; only LF is accepted");
  if (sha256(HELPER_OLD) !== HELPER_SHA || sha256(ROUTE_OLD) !== ROUTE_SHA) fail("embedded span hash mismatch");
  if (HELPER_OLD.length !== 653 || ROUTE_OLD.length !== 730) fail("embedded span length mismatch");
  if (HELPER_NEW.length !== 88 || ROUTE_NEW.length !== 109) fail("replacement length mismatch");
  for (const span of [HELPER_OLD, ROUTE_OLD, HELPER_NEW, ROUTE_NEW]) {
    const text = span.toString("utf8");
    if (text.includes("[REDACTED") || text.includes("BEGIN ") || text.includes("PRIVATE KEY")) {
      fail("span contains a redaction or key marker");
    }
  }
  const helpers = findAll(input, HELPER_OLD);
  if (helpers.length !== 1) fail("rename helper anchor count is " + helpers.length);
  const helperAt = helpers[0];
  const scopes = findAll(input, SCOPE_START);
  if (scopes.length !== 1) fail("handleAuthRequest anchor count is " + scopes.length);
  const scopeAt = scopes[0];
  const scopeEnds = findAll(input.subarray(scopeAt), SCOPE_END);
  if (scopeEnds.length !== 1) fail("handleAuthRequest end count is " + scopeEnds.length);
  const scopeEnd = scopeAt + scopeEnds[0];
  const scope = input.subarray(scopeAt, scopeEnd);
  const routes = findAll(scope, ROUTE_OLD);
  if (routes.length !== 1) fail("rename route span count in handleAuthRequest is " + routes.length);
  const routeAt = scopeAt + routes[0];
  if (findAll(input, ROUTE_OLD).length !== 1) fail("rename route span is not globally unique");
  const notFoundInScope = findAll(scope, NOT_FOUND);
  if (notFoundInScope.length !== 1) fail("scoped not_found count is " + notFoundInScope.length);
  if (scopeAt + notFoundInScope[0] !== routeAt + ROUTE_OLD.length) fail("route span does not end at the scoped not_found return");
  if (!(helperAt + HELPER_OLD.length < routeAt)) fail("helper span does not precede the route span");
  const prefix = input.subarray(0, helperAt);
  const middle = input.subarray(helperAt + HELPER_OLD.length, routeAt);
  const suffix = input.subarray(routeAt + ROUTE_OLD.length);
  const output = Buffer.concat([prefix, HELPER_NEW, middle, ROUTE_NEW, suffix]);
  const restored = Buffer.concat([prefix, HELPER_OLD, middle, ROUTE_OLD, suffix]);
  if (!restored.equals(input)) fail("reverse patch does not restore the input");
  const diff = [
    "--- input",
    "+++ output",
    "@@ helper " + helperAt + " " + HELPER_OLD.length + " -> " + HELPER_NEW.length + " @@",
    ...HELPER_OLD.toString("utf8").split("\n").map((line) => "-" + line),
    ...HELPER_NEW.toString("utf8").split("\n").map((line) => "+" + line),
    "@@ route " + routeAt + " " + ROUTE_OLD.length + " -> " + ROUTE_NEW.length + " @@",
    ...ROUTE_OLD.toString("utf8").split("\n").map((line) => "-" + line),
    ...ROUTE_NEW.toString("utf8").split("\n").map((line) => "+" + line),
    "",
  ].join("\n");
  if (diff.includes("[REDACTED") || diff.includes("BEGIN ") || diff.includes("PRIVATE KEY")) {
    fail("diff contains a redaction or key marker");
  }
  return {
    output,
    diff,
    manifest: {
      input: { length: input.length, sha256: sha256(input) },
      output: { length: output.length, sha256: sha256(output) },
      reverseRestoresInput: true,
      spans: {
        helper: { offset: helperAt, oldLength: 653, newLength: 88, oldSha256: HELPER_SHA },
        route: { offset: routeAt, oldLength: 730, newLength: 109, oldSha256: ROUTE_SHA },
      },
      unchanged: {
        prefix: { length: prefix.length, sha256: sha256(prefix) },
        middle: { length: middle.length, sha256: sha256(middle) },
        suffix: { length: suffix.length, sha256: sha256(suffix) },
      },
    },
  };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return "";
  return process.argv[index + 1];
}

function main() {
  const inputPath = arg("--input");
  const outputPath = arg("--output");
  const expected = arg("--expected-sha256").toLowerCase();
  const manifestPath = arg("--manifest");
  const diffPath = arg("--diff");
  if (!inputPath || !outputPath || !expected || !manifestPath || !diffPath) {
    process.stderr.write("usage: patch-v132-rename-deny.mjs --input FILE --output FILE --expected-sha256 HEX --manifest FILE --diff FILE\n");
    process.exit(2);
  }
  if (!/^[0-9a-f]{64}$/.test(expected)) fail("expected sha256 must be 64 hex characters");
  if (inputPath === outputPath || inputPath === manifestPath || inputPath === diffPath) fail("refusing to overwrite the input");
  if (existsSync(outputPath) || existsSync(manifestPath) || existsSync(diffPath)) fail("output path already exists");
  const input = readFileSync(inputPath);
  if (sha256(input) !== expected) fail("input sha256 does not match --expected-sha256");
  const patched = patchRenameDeny(input);
  writeFileSync(outputPath, patched.output, { mode: 0o600, flag: "wx" });
  chmodSync(outputPath, 0o600);
  writeFileSync(manifestPath, JSON.stringify(patched.manifest, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(manifestPath, 0o600);
  writeFileSync(diffPath, patched.diff, { mode: 0o600, flag: "wx" });
  chmodSync(diffPath, 0o600);
  const written = readFileSync(outputPath);
  if (!written.equals(patched.output)) {
    unlinkSync(outputPath);
    fail("written output does not match the patch");
  }
  process.stdout.write(JSON.stringify({
    inputSha256: patched.manifest.input.sha256,
    outputSha256: patched.manifest.output.sha256,
    helperOffset: patched.manifest.spans.helper.offset,
    routeOffset: patched.manifest.spans.route.offset,
    reverseRestoresInput: true,
  }) + "\n");
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  try {
    main();
  } catch (error) {
    process.stderr.write(String(error.message || error) + "\n");
    process.exit(1);
  }
}
