#!/usr/bin/env node
/**
 * Plan the owner auto log-off default.
 *
 * Dry-run is the default. This file does not call the network.
 * It does not write Firestore. Apply happens in the email worker, after a
 * human has read a dry-run report. Do not run that apply against production
 * from this script.
 *
 * The fixture is the private tenant fields (or a tenant object). Off, "0",
 * "off", "", null, or a missing ownerIdleTimeoutMin becomes 30 when
 * ownerIdleDefaultApplied is not already true. 15, 30, and 60 stay. A row
 * that already has the flag is skipped, including a later Off.
 *
 * Local dry-run (no network):
 *   node scripts/migrate-owner-idle.mjs --dry-run --fixture tenants.json
 *
 * Production dry-run (human, after MIGRATION_TOKEN is set on the email worker):
 *   curl -sS -X POST 'https://schedi.app/api/profile' \
 *     -H 'Content-Type: application/json' \
 *     -H 'Authorization: Bearer $MIGRATION_TOKEN' \
 *     -d '{"action":"migrate_owner_idle","dryRun":true,"session":"AGENCY_SESSION"}'
 *
 * Production apply, only after that report is right. The worker patches the
 * private doc only. Owners can still choose Off, 15, 30, or 60 afterward.
 *   curl -sS -X POST 'https://schedi.app/api/profile' \
 *     -H 'Content-Type: application/json' \
 *     -H 'Authorization: Bearer $MIGRATION_TOKEN' \
 *     -d '{"action":"migrate_owner_idle","dryRun":false,"session":"AGENCY_SESSION"}'
 *
 * The timeout is not stored on the server yet, so the first production
 * dry-run counts every tenant as setTo30. A browser that already chose 15
 * or 60 writes that choice back once.
 */
import { readFileSync } from 'node:fs';
import { planOwnerIdleDefault, summarizeOwnerIdlePlans } from '../workers/schedi-email-worker/src/owner-idle.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');

if (apply) {
  console.error('This script does not write. Apply with POST /api/profile {"action":"migrate_owner_idle","dryRun":false} after a dry-run.');
  console.error('That call needs an agency session and Authorization: Bearer $MIGRATION_TOKEN.');
  process.exit(1);
}

if (!args.includes('--dry-run')) {
  console.error('Refusing to run without --dry-run.');
  console.error('Local: node scripts/migrate-owner-idle.mjs --dry-run --fixture tenants.json');
  process.exit(1);
}

const fixtureAt = args.indexOf('--fixture');
if (fixtureAt < 0) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    network: false,
    tenants: 0,
    counts: { setTo30: 0, leftChosen: 0, alreadyApplied: 0 },
    note: 'Pass --fixture <file> with local JSON. This script does not call the network and does not write.',
  }));
  process.exit(0);
}

const file = args[fixtureAt + 1];
if (!file) {
  console.error('Missing fixture path.');
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(file, 'utf8'));
const docs = Array.isArray(parsed) ? parsed : [parsed];
const plans = docs.map((doc) => {
  const id = String((doc && (doc.id || doc.slug)) || '');
  const plan = planOwnerIdleDefault(doc || {});
  return {
    id,
    action: plan.action,
    reason: plan.reason,
    minutes: plan.minutes,
    patch: plan.patch,
  };
});

console.log(JSON.stringify({
  ok: true,
  dryRun: true,
  network: false,
  tenants: plans.length,
  counts: summarizeOwnerIdlePlans(plans),
  plans,
}, null, 2));
