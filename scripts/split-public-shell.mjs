// Builds site/hq.html (full app, HQ regions marked) and index.html (public/owner shell).
// Re-run: node --experimental-strip-types scripts/split-public-shell.mjs
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellHasHqMarkers, stripPublicShell } from "../worker/public-shell.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "index.html");
const hqPath = join(root, "site", "hq.html");

function once(html, from, to, label) {
  const at = html.indexOf(from);
  if (at < 0) throw new Error("missing " + label);
  if (html.indexOf(from, at + from.length) >= 0) throw new Error("duplicate " + label);
  return html.slice(0, at) + to + html.slice(at + from.length);
}

function wrapBetween(html, start, endExclusive, kind) {
  const a = html.indexOf(start);
  if (a < 0) throw new Error("start not found: " + start.slice(0, 90));
  if (html.indexOf(start, a + start.length) >= 0) throw new Error("duplicate start: " + start.slice(0, 90));
  const b = html.indexOf(endExclusive, a + start.length);
  if (b < 0) throw new Error("end not found after " + start.slice(0, 60) + " :: " + endExclusive.slice(0, 60));
  const open = kind === "js" ? "// SCHEDI_HQ_START\n" : "<!-- SCHEDI_HQ_START -->\n";
  const close = kind === "js" ? "// SCHEDI_HQ_END\n" : "<!-- SCHEDI_HQ_END -->\n";
  return html.slice(0, a) + open + html.slice(a, b) + close + html.slice(b);
}

function transform(html) {
  html = once(
    html,
    "            currentMode: 'agency', ",
    "            currentMode: 'tenant', ",
    "currentMode",
  );
  html = once(html, 'value="vance123"', 'value=""', "vance123");
  html = once(html, 'value="client_id_siteforge_paypal_881"', 'value=""', "paypal placeholder");
  html = once(
    html,
    "        html.schedi-light #navModeAgency.bg-slate-800, html.schedi-light #navModeTenant.bg-slate-800 { background-color: #e2e8f0 !important; }",
    "        html.schedi-light #navModeTenant.bg-slate-800 { background-color: #e2e8f0 !important; }\n        <!-- SCHEDI_HQ_START -->\n        html.schedi-light #navModeAgency.bg-slate-800 { background-color: #e2e8f0 !important; }\n        <!-- SCHEDI_HQ_END -->",
    "navModeAgency css",
  );
  html = html
    .replaceAll("document.getElementById('agencyHqSection')", "hqSectionEl()")
    .replaceAll("document.getElementById('navModeAgency')", "hqNavButton()")
    .replaceAll("document.getElementById('masterAuthBtn')", "hqMasterButton()");

  html = once(
    html,
    `        var SCHEDI_AGENCY_HQ_SEGMENT = 'hq-9h7p52';

        function agencyHqPath() {
            return '/' + SCHEDI_AGENCY_HQ_SEGMENT;
        }

        function isAgencyHqRoute() {
            try {
                var path = (window.location.pathname || '/').replace(/\\/+/g, '/');
                var parts = path.split('/').filter(Boolean);
                return parts.length >= 1 && String(parts[0]).toLowerCase() === SCHEDI_AGENCY_HQ_SEGMENT;
            } catch (err) {
                return false;
            }
        }

        function isReservedBusinessSlug(slug) {
            var first = String(slug || '').toLowerCase();
            if (!first) return true;
            if (first === SCHEDI_AGENCY_HQ_SEGMENT) return true;
            if (first === 'index.html' || first === 'agency' || first === 'admin' || first === 'hq' || first === 'signup' || first === 'terms' || first === 'privacy' || first === 'help' || first === 'auth' || first === 'reset' || first === 'billing' || first === 'api' || first === 'www' || first === 'schedi' || first === 'index' || first === 'login' || first === 'features' || first === 'compare' || first === 'for' || first === 'pricing' || first === 'portal') return true;
            return false;
        }`,
    `        var SCHEDI_AGENCY_HQ_SEGMENT = 'hq';
        // SCHEDI_HQ_START
        SCHEDI_AGENCY_HQ_SEGMENT = 'hq-9h7p52';
        // SCHEDI_HQ_END

        function agencyHqPath() {
            return '/hq';
        }

        function isAgencyHqRoute() {
            try {
                var path = (window.location.pathname || '/').replace(/\\/+/g, '/');
                var parts = path.split('/').filter(Boolean);
                if (!parts.length) return false;
                var first = String(parts[0]).toLowerCase();
                if (parts.length === 1 && (first === 'hq' || first === 'agency')) return true;
                // SCHEDI_HQ_START
                if (first === 'hq-9h7p52') return true;
                // SCHEDI_HQ_END
                return false;
            } catch (err) {
                return false;
            }
        }

        function isReservedBusinessSlug(slug) {
            var first = String(slug || '').toLowerCase();
            if (!first) return true;
            if (first === 'index.html' || first === 'agency' || first === 'admin' || first === 'hq' || first === 'signup' || first === 'terms' || first === 'privacy' || first === 'help' || first === 'auth' || first === 'reset' || first === 'billing' || first === 'api' || first === 'www' || first === 'schedi' || first === 'index' || first === 'login' || first === 'features' || first === 'compare' || first === 'for' || first === 'pricing' || first === 'portal') return true;
            // SCHEDI_HQ_START
            if (first === 'hq-9h7p52') return true;
            // SCHEDI_HQ_END
            return false;
        }`,
    "hq path helpers",
  );

  html = once(
    html,
    "        function syncAgencyChrome() {",
    `        function hqSectionEl() {
            return document.getElementById('agencyHqSection');
        }
        function hqNavButton() {
            return document.getElementById('navModeAgency');
        }
        function hqMasterButton() {
            return document.getElementById('masterAuthBtn');
        }
        function restoreAgencyChromeAfterPreview() {
            platformState.currentMode = 'agency';
            var agSec = hqSectionEl();
            var teSec = document.getElementById('tenantPortalSection');
            if (teSec) teSec.classList.add('hidden');
            if (agSec) agSec.classList.remove('hidden');
            var btnAg = hqNavButton();
            var btnTe = document.getElementById('navModeTenant');
            var btnPr = document.getElementById('navModePreview');
            if (btnTe) btnTe.className = 'px-3.5 py-1.5 rounded-lg font-medium transition-all text-slate-400 hover:text-white flex items-center space-x-1.5';
            if (btnPr) btnPr.className = 'hidden px-3.5 py-1.5 rounded-lg font-medium transition-all text-slate-400 hover:text-white items-center space-x-1.5';
            if (btnAg) btnAg.className = 'px-3.5 py-1.5 rounded-lg font-bold transition-all text-brand-400 bg-slate-800 shadow-sm flex items-center space-x-1.5';
            renderAgencyDashboard();
            syncAgencyChrome();
        }

        function syncAgencyChrome() {`,
    "hq helpers",
  );

  html = once(
    html,
    `                if (platformState.currentMode === 'preview') {
                    if (isAgencyHqRoute()) {
                        platformState.currentMode = 'agency';
                        const agSec = hqSectionEl();
                        const teSec = document.getElementById('tenantPortalSection');
                        if (teSec) teSec.classList.add('hidden');
                        if (agSec) agSec.classList.remove('hidden');
                        const btnAg = hqNavButton();
                        const btnTe = document.getElementById('navModeTenant');
                        const btnPr = document.getElementById('navModePreview');
                        if (btnTe) btnTe.className = 'px-3.5 py-1.5 rounded-lg font-medium transition-all text-slate-400 hover:text-white flex items-center space-x-1.5';
                        if (btnPr) btnPr.className = 'hidden px-3.5 py-1.5 rounded-lg font-medium transition-all text-slate-400 hover:text-white items-center space-x-1.5';
                        if (btnAg) btnAg.className = 'px-3.5 py-1.5 rounded-lg font-bold transition-all text-brand-400 bg-slate-800 shadow-sm flex items-center space-x-1.5';
                        renderAgencyDashboard();
                        syncAgencyChrome();
                    } else {
                        switchPlatformMode('tenant');
                    }
                }`,
    `                if (platformState.currentMode === 'preview') {
                    if (isAgencyHqRoute()) restoreAgencyChromeAfterPreview();
                    else switchPlatformMode('tenant');
                }`,
    "preview chrome",
  );

  html = once(
    html,
    `        window.toggleMasterAgencyAuth = function() {
            if (platformState.isAgencyMasterLoggedIn) {
                platformState.isAgencyMasterLoggedIn = false;
                platformState.appointmentCounts = null;
                clearPrivateAppointments();
                clearPrivateProfiles();
                schediClearAuthSession();`,
    `        window.toggleMasterAgencyAuth = function() {
            if (platformState.isAgencyMasterLoggedIn) {
                var session = '';
                try { session = schediAuthSession(); } catch (errSess) { session = ''; }
                platformState.isAgencyMasterLoggedIn = false;
                platformState.appointmentCounts = null;
                clearPrivateAppointments();
                clearPrivateProfiles();
                schediClearAuthSession();
                try {
                    fetch('https://schedi.app/auth/logout', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ session: session })
                    });
                } catch (errOut) {}`,
    "logout",
  );

  html = once(
    html,
    `            ['agencyHqSection', 'tenantPortalSection', 'previewSection', 'signupSection', 'legalSection'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });`,
    `            ['tenantPortalSection', 'previewSection', 'signupSection', 'legalSection'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el) el.classList.add('hidden');
            });
            var hqReset = hqSectionEl();
            if (hqReset) hqReset.classList.add('hidden');`,
    "reset hide list",
  );

  const regions = [
    ["        function refreshEmailSenderUI() {", "        function getTenantPublicBookingSlug(tenant) {", "js"],
    ["        function renderAgencyDashboard() {", "        function schediBillingLabel(t) {", "js"],
    ["        window.handleAgencyMasterLogin = async function(e) {", "        function canAccessLivePreview() {", "js"],
    ["        window.hqBackToDirectory = function() {", "        function getTenant(id = platformState.activeTenantId) {", "js"],
    ["        function hqSectionEl() {", "        function getPublicSlugFromPath() {", "js"],
    ["        window.syncEditMonthlyFeeFromPlan = function() {", "        function roundMoney(n) {", "js"],
    ["        async function schediSendProvisionEmails(info) {", "        async function schediStoreOwnerPassword(tenantId, ownerEmail, newPassword) {", "js"],
    ["    <!-- UPDATE TENANT PROFILE -->", "    <!-- UPDATE SUBSCRIPTION PAYMENT METHOD", "html"],
    ["    <!-- PROVISION NEW TENANT -->", "    <!-- UPDATE TENANT PROFILE -->", "html"],
    ['                <div id="hqManagingBanner"', "                <!-- ROSTER-FIRST:", "html"],
    ["        <!-- AGENCY HQ SECTION -->", "        <!-- BUSINESS OWNER PORTAL SECTION -->", "html"],
    ['                <button type="button" id="masterAuthBtn"', "            </div>\n\n        </div>\n    </header>", "html"],
    ['                <div id="tenantSelectorContainer"', '                <button type="button" id="schediThemeBtn"', "html"],
    ['                    <button type="button" id="navModeAgency"', '                    <button type="button" id="navModeTenant"', "html"],
    ["        .hq-table th {", "        html.schedi-light .text-emerald-200", "html"],
  ];
  // Top to bottom so a later region's opening marker is not swallowed by the previous region's end anchor.
  for (const [start, end, kind] of regions.reverse()) {
    html = wrapBetween(html, start, end, kind);
  }
  return html;
}

let full;
if (existsSync(hqPath) && readFileSync(hqPath, "utf8").includes("Agency HQ Master Login")) {
  full = readFileSync(hqPath, "utf8");
  if (!full.includes("SCHEDI_HQ_START")) throw new Error("site/hq.html is missing HQ markers");
} else {
  const source = readFileSync(indexPath, "utf8");
  if (!source.includes("Agency HQ Master Login")) throw new Error("index.html has no HQ source to split");
  full = transform(source);
}

const pub = stripPublicShell(full);
const leaked = shellHasHqMarkers(pub);
if (leaked) {
  const i = pub.indexOf(leaked);
  console.error(JSON.stringify(pub.slice(Math.max(0, i - 180), i + leaked.length + 180)));
  throw new Error("public shell still contains " + leaked);
}
if (!full.includes('id="agencyHqSection"')) throw new Error("HQ shell lost the dashboard");
if (!pub.includes("function generateStandaloneHtmlForTenant")) throw new Error("public shell lost booking iframe");
if (!pub.includes("function ownerPlanActiveUntilText")) throw new Error("public shell lost owner billing");
if (!pub.includes("function hqSectionEl(){return null;}")) throw new Error("public shell missing stubs");
if (pub.includes("hq-9h7p52")) throw new Error("public shell still names the legacy HQ path");

writeFileSync(hqPath, full);
writeFileSync(indexPath, pub);
console.log("wrote site/hq.html and stripped index.html");
