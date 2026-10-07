import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const marketingStart = html.indexOf('id="marketingSection"');
const marketingEnd = html.indexOf('id="signupSection"');
assert.ok(marketingStart > 0 && marketingEnd > marketingStart, "marketing section sits before signup");
const marketing = html.slice(marketingStart, marketingEnd);

for (const banned of [
  "SMS",
  "waitlist",
  "reviews",
  "Google booking",
  "AI receptionist",
  "multi-staff",
  "QR code",
  "QR codes",
]) {
  assert.equal(marketing.toLowerCase().includes(banned.toLowerCase()), false, `marketing copy claims ${banned}`);
}

assert.match(marketing, /\$0/);
assert.match(marketing, /\$29\/mo/);
assert.match(marketing, /\$49\/mo/);
assert.match(marketing, /five bookings a week/);
assert.match(marketing, /pay at the appointment/i);
assert.match(marketing, /Cash App, Venmo, Zelle, and PayPal/);
assert.match(marketing, /off until you turn it on/);
assert.match(marketing, /href="\/signup"/);
assert.match(marketing, /href="\/help"/);
assert.match(marketing, /href="\/\?portal=login"/);

assert.match(html, /isSignupRoute\(\)\) \{\s*showSignupPage\(\);\s*return;/);
assert.match(html, /else if \(billingBack \|\| ownerShouldSeePortal\(\)\) \{\s*switchPlatformMode\('tenant'\);/);
assert.match(html, /else if \(isBareHomeRoute\(\)\) \{\s*showMarketingPage\(\);/);
assert.match(html, /currentMode !== 'marketing'/);
assert.match(html, /portal=login/);

console.log("marketing home source checks passed");
