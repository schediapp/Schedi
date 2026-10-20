#!/usr/bin/env node
/**
 * DRY-RUN ONLY.
 * Prints public-tenant fields that a cleanup would remove.
 * There is no write path in this file. Do not add one.
 * Do not run this against production.
 */
import { readFileSync } from 'node:fs';
import { publicFieldsToTrim } from '../workers/schedi-email-worker/src/tenant-private.js';

const args = process.argv.slice(2);
if (!args.includes('--dry-run')) {
  console.error('Refusing to run without --dry-run. This script never writes.');
  process.exit(1);
}

const fixtureAt = args.indexOf('--fixture');
if (fixtureAt < 0) {
  console.log(JSON.stringify({
    ok: true,
    dryRun: true,
    network: false,
    tenants: 0,
    note: 'Pass --fixture <file> with local JSON. This script does not call the network.',
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
  return { id, remove: publicFieldsToTrim(doc || {}) };
});

console.log(JSON.stringify({ ok: true, dryRun: true, network: false, tenants: plans.length, plans }));
