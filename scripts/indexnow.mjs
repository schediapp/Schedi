#!/usr/bin/env node
// Submit the live sitemap to IndexNow after a production deploy.
//
// Generate a key (32+ hex characters; 64 from openssl is a good default):
//   openssl rand -hex 32
// Store it as the Worker secret INDEXNOW_KEY (the site serves it at /<key>.txt)
// and pass the same value to this script. Never commit the key.
//
// This script POSTs only when BOTH are set:
//   INDEXNOW_ENABLED=true
//   INDEXNOW_HOST=schedi.app
// Preview deploys must leave INDEXNOW_ENABLED unset (or not set the host to
// schedi.app). A preview worker name such as schedi-web-preview never pings.
//
//   INDEXNOW_ENABLED=true INDEXNOW_HOST=schedi.app INDEXNOW_KEY=<hex> node scripts/indexnow.mjs

const ENDPOINT = "https://api.indexnow.org/indexnow";

function gate() {
  if (String(process.env.INDEXNOW_ENABLED || "").trim() !== "true") return { ok: false, reason: "disabled" };
  if (String(process.env.INDEXNOW_HOST || "").trim().toLowerCase() !== "schedi.app") return { ok: false, reason: "host" };
  const key = String(process.env.INDEXNOW_KEY || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32,128}$/.test(key)) return { ok: false, reason: "key" };
  return { ok: true, key };
}

const decision = gate();
if (!decision.ok) {
  console.log(`IndexNow skipped (${decision.reason}). Preview and non-production deploys do not ping.`);
  process.exit(0);
}

const sitemap = await fetch("https://schedi.app/sitemap.xml");
if (!sitemap.ok) {
  console.error(`IndexNow: sitemap fetch failed (${sitemap.status})`);
  process.exit(1);
}
const xml = await sitemap.text();
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
if (!urlList.length) {
  console.error("IndexNow: sitemap had no URLs");
  process.exit(1);
}

const payload = {
  host: "schedi.app",
  key: decision.key,
  keyLocation: `https://schedi.app/${decision.key}.txt`,
  urlList,
};
const response = await fetch(ENDPOINT, {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(payload),
});
console.log(`IndexNow submitted ${urlList.length} URL(s), status ${response.status}`);
if (!response.ok) process.exit(1);
