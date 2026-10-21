#!/usr/bin/env node
/**
 * Plan the tenant private-field move.
 *
 * Dry-run is the default. This file does not call the network.
 * It does not write Firestore. Apply happens in the email worker, after a
 * human has read a dry-run report. Do not run that apply against production
 * from this script.
 *
 * Local dry-run (no network):
 *   node scripts/migrate-tenant-private.mjs --dry-run --fixture tenants.json
 *
 * Production dry-run (human, after MIGRATION_TOKEN is set on the email worker):
 *   curl -sS -X POST 'https://schedi.app/api/profile' \
 *     -H 'Content-Type: application/json' \
 *     -H 'Authorization: Bearer $MIGRATION_TOKEN' \
 *     -d '{"action":"migrate_private","dryRun":true,"session":"AGENCY_SESSION"}'
 *
 * Production apply, only after that report is right. Copy keys the private
 * doc does not already have, verify those copies and that every field about
 * to be deleted is already on the private doc, write acceptingBookings, then
 * delete. Keys already stored privately are left alone. The public plan tier
 * is kept. This local planner has no private doc, so it lists every public
 * private-field as a copy.
 *   curl -sS -X POST 'https://schedi.app/api/profile' \
 *     -H 'Content-Type: application/json' \
 *     -H 'Authorization: Bearer $MIGRATION_TOKEN' \
 *     -d '{"action":"migrate_private","dryRun":false,"session":"AGENCY_SESSION"}'
 */
import { readFileSync } from 'node:fs';
import { planTenantPrivateMove } from '../workers/schedi-email-worker/src/tenant-private.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');

if (apply) {
  console.error('This script does not write. Apply with POST /api/profile {"action":"migrate_private","dryRun":false} after a dry-run.');
  console.error('That call needs an agency session and Authorization: Bearer $MIGRATION_TOKEN.');
  process.exit(1);
}

if (!args.includes('--dry-run')) {
  console.error('Refusing to run without --dry-run.');
  console.error('Local: node scripts/migrate-tenant-private.mjs --dry-run --fixture tenants.json');
  process.exit(1);
}

const fixtureAt = args.indexOf('--fixture');
if (fixtureAt < 0) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    network: false,
    tenants: 0,
    order: ['copy', 'verify', 'publicPatch', 'delete'],
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
  const move = planTenantPrivateMove(doc || {});
  return {
    id,
    copy: Object.keys(move.copy),
    publicPatch: move.publicPatch,
    remove: move.remove,
  };
});

console.log(JSON.stringify({
  ok: true,
  dryRun: true,
  network: false,
  order: ['copy', 'verify', 'publicPatch', 'delete'],
  tenants: plans.length,
  plans,
}, null, 2));
