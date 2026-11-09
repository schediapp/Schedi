/**
 * Operator export of platform events, connected-account ids, and per-account events.
 * It calls Stripe only when you pass --execute and STRIPE_SECRET_KEY is set in the
 * environment. It prints counts, not the key and not event bodies.
 *
 *   node --experimental-strip-types scripts/connect-stripe-export.ts --out /tmp/events.json --execute
 *   node --experimental-strip-types scripts/connect-stripe-export.ts --out /tmp/events.json --execute --created-gte 1730000000
 *
 * Without --execute it exits before any network call.
 */
import { existsSync } from "node:fs";
import { exportAndSaveStripeMigrationSet, type StripeLister, type StripePage } from "../src/lib/stripe-export.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const out = arg("--out");
const execute = process.argv.includes("--execute");
const createdGte = arg("--created-gte");
if (!out || out.includes("://")) fail("--out must be a local json path.");
if (existsSync(out)) fail("Refusing to overwrite the output file.");
if (!execute) {
  console.log(JSON.stringify({
    ok: true,
    executed: false,
    note: "No Stripe call. Re-run with --execute after STRIPE_SECRET_KEY is in the environment. The key is not printed.",
  }, null, 2));
  process.exit(0);
}

const key = process.env.STRIPE_SECRET_KEY || "";
if (!key) fail("STRIPE_SECRET_KEY is not set. Nothing was called.");

const lister: StripeLister = {
  async get(path: string, accountId?: string): Promise<StripePage> {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (accountId) headers["stripe-account"] = accountId;
    const response = await fetch(`https://api.stripe.com${path}`, { headers });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Stripe ${response.status} for ${path.split("?")[0]}: ${detail.slice(0, 180)}`);
    }
    return await response.json() as StripePage;
  },
};

let exported;
try {
  exported = await exportAndSaveStripeMigrationSet(lister, out, createdGte ? Number(createdGte) : undefined);
} catch (error) {
  fail(error instanceof Error ? error.message : "Stripe export did not finish. No file was written.");
}
console.log(JSON.stringify({
  ok: true,
  complete: true,
  executed: true,
  platformEvents: exported.platformEvents.length,
  accounts: exported.accountIds.length,
  connectEvents: exported.connectEvents.length,
}, null, 2));
