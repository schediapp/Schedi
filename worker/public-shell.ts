// Strips Agency HQ screens out of the shell served to public booking pages and the owner portal.
// The full shell (site/hq.html) keeps the same markers and is only returned for an agency session.

export const AGENCY_COOKIE = "schedi_hq";

export const HQ_PATHS = new Set(["hq", "agency", "hq-9h7p52"]);

/** Strings that identify private HQ screens, the legacy path, or placeholder credentials. */
export const HQ_PUBLIC_MARKERS = [
  "hq-9h7p52",
  "id=\"agencyHqSection\"",
  "id=\"agencyMasterPassword\"",
  "Agency HQ Master Login",
  "id=\"statAgencyMRR\"",
  "Agency MRR",
  "id=\"editComplimentaryPro\"",
  "Provision New Client Business",
  "client_id_siteforge_paypal_881",
  "vance123",
  "id=\"hqManagingBanner\"",
  "id=\"masterAuthBtn\"",
  "id=\"navModeAgency\"",
  "Authenticate Master Agency HQ",
  "Cross-Tenant Volume",
  "Master administrator credentials",
  "master administrator credentials",
  "getElementById('agencyHqSection')",
  "getElementById('navModeAgency')",
  "getElementById('masterAuthBtn')",
  "getElementById('editComplimentaryPro')",
] as const;

const HTML_START = "<!-- SCHEDI_HQ_START -->";
const HTML_END = "<!-- SCHEDI_HQ_END -->";
const JS_START = "// SCHEDI_HQ_START";
const JS_END = "// SCHEDI_HQ_END";

const PUBLIC_STUBS = `<script>
function hqSectionEl(){return null;}
function hqNavButton(){return null;}
function hqMasterButton(){return null;}
function syncAgencyChrome(){}
function syncHqManagingBanner(){}
function updateMasterAuthUI(){}
function renderAgencyDashboard(){}
function refreshEmailSenderUI(){}
function restoreAgencyChromeAfterPreview(){}
window.loginAsTenantOwner=function(){};
window.handleAgencyMasterLogin=function(e){if(e&&e.preventDefault)e.preventDefault();};
window.toggleMasterAgencyAuth=function(){};
window.syncEditMonthlyFeeFromPlan=function(){};
window.onComplimentaryProToggle=function(){};
window.handleSaveAgencyGateways=function(e){if(e&&e.preventDefault)e.preventDefault();};
window.handleSaveEmailSender=function(e){if(e&&e.preventDefault)e.preventDefault();};
window.testEmailSenderWebhook=function(){};
</script>
`;

function cutPairs(source: string, start: string, end: string): { text: string; removed: number } {
  let out = "";
  let removed = 0;
  let i = 0;
  while (i < source.length) {
    const at = source.indexOf(start, i);
    if (at < 0) {
      out += source.slice(i);
      break;
    }
    const stop = source.indexOf(end, at + start.length);
    if (stop < 0) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, at);
    i = stop + end.length;
    if (source[i] === "\r") i += 1;
    if (source[i] === "\n") i += 1;
    removed += 1;
  }
  return { text: out, removed };
}

export function stripPublicShell(html: string): string {
  const htmlCut = cutPairs(html, HTML_START, HTML_END);
  const jsCut = cutPairs(htmlCut.text, JS_START, JS_END);
  let text = jsCut.text;
  const removed = htmlCut.removed + jsCut.removed;
  if (removed > 0 && !text.includes("function hqSectionEl(){return null;}")) {
    const close = text.lastIndexOf("</body>");
    if (close >= 0) text = text.slice(0, close) + PUBLIC_STUBS + text.slice(close);
  }
  return text;
}

export function shellHasHqMarkers(html: string): string | null {
  for (const marker of HQ_PUBLIC_MARKERS) {
    if (html.includes(marker)) return marker;
  }
  return null;
}

export function agencySessionToken(request: Request): string {
  const header = (request.headers.get("x-schedi-session") || "").trim();
  if (header) return header.slice(0, 256);
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() !== AGENCY_COOKIE) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw).slice(0, 256);
    } catch {
      return raw.slice(0, 256);
    }
  }
  return "";
}

export interface AgencyKv {
  get(key: string): Promise<string | null>;
  put?(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list?(options: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    keys: { name: string }[];
    list_complete?: boolean;
    cursor?: string;
  }>;
}

export async function hasAgencySession(kv: AgencyKv | undefined, token: string): Promise<boolean> {
  if (!kv || !token) return false;
  let raw: string | null = null;
  try {
    raw = await kv.get("session:" + token);
  } catch {
    return false;
  }
  if (!raw) return false;
  try {
    const session = JSON.parse(raw) as { role?: string; exp?: number };
    if (!session || session.role !== "agency") return false;
    if (Number(session.exp || 0) < Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

export function hqLoginDocument(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Schedi HQ sign in</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#e2e8f0;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
form{width:min(420px,calc(100% - 32px));background:#111827;border:1px solid #1f2937;border-radius:16px;padding:28px;display:flex;flex-direction:column;gap:12px}
h1{margin:0;font-size:22px}
p{margin:0;color:#94a3b8;font-size:13px}
label{font-size:12px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#fff}
button{margin-top:6px;padding:12px;border:0;border-radius:12px;background:#10b981;color:#042f2e;font-weight:800;cursor:pointer}
.err{color:#fda4af;font-size:12px;min-height:1em}
#hq-theme{display:none}
html.schedi-newhq body{background:#06080d;color:#e7edf5}
html.schedi-newhq form{background:#121826;border:1px solid rgba(148,163,184,.18);border-radius:20px;padding:28px}
html.schedi-newhq h1{font-size:1.7rem;font-weight:800;letter-spacing:-0.03em}
html.schedi-newhq p{color:#94a3b8}
html.schedi-newhq input{background:#0c1018;border-color:rgba(148,163,184,.28);border-radius:12px;min-height:44px}
html.schedi-newhq button{min-height:44px;border-radius:12px}
html.schedi-newhq #hq-theme{display:inline-flex;align-self:flex-start;margin-top:0;padding:8px 12px;background:#121826;color:#e7edf5;border:1px solid rgba(148,163,184,.28);font-size:12px}
html.schedi-light.schedi-newhq body{background:#f4f7fb;color:#0f172a}
html.schedi-light.schedi-newhq form{background:#ffffff;border-color:#d7dee8}
html.schedi-light.schedi-newhq p{color:#475569}
html.schedi-light.schedi-newhq input{background:#ffffff;color:#0f172a;border-color:#cbd5e1}
html.schedi-light.schedi-newhq button[type="submit"]{background:#059669;color:#ffffff}
html.schedi-light.schedi-newhq #hq-theme{background:#ffffff;color:#0f172a;border-color:#d7dee8}
</style>
</head>
<body>
<form id="hq-login">
<button type="button" id="hq-theme">Light</button>
<h1>Schedi HQ</h1>
<p>Sign in to open HQ.</p>
<label for="hq-email">Email</label>
<input id="hq-email" name="email" type="email" autocomplete="username" required>
<label for="hq-password">Password</label>
<input id="hq-password" name="password" type="password" autocomplete="current-password" required>
<div class="err" id="hq-error" role="alert"></div>
<button type="submit">Sign in</button>
</form>
<script>
(function () {
  var on = true;
  try {
    var q = new URLSearchParams(location.search || '');
    var flag = q.get('newhq');
    var classic = q.get('classichq');
    if (flag === '0' || flag === 'false' || flag === 'off') on = false;
    if (flag === '1' || flag === 'true' || flag === 'on') on = true;
    if (classic === '1' || classic === 'true' || classic === 'on') on = false;
  } catch (errFlag) { on = true; }
  if (!on) return;
  document.documentElement.classList.add('schedi-newhq');
  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap';
  document.head.appendChild(link);
  function paint(theme) {
    var light = theme === 'light';
    document.documentElement.classList.toggle('schedi-light', light);
    var toggle = document.getElementById('hq-theme');
    if (toggle) toggle.textContent = light ? 'Dark' : 'Light';
  }
  var theme = 'dark';
  try { theme = localStorage.getItem('schedi.theme') === 'light' ? 'light' : 'dark'; } catch (errTheme) { theme = 'dark'; }
  paint(theme);
  var toggle = document.getElementById('hq-theme');
  if (toggle) toggle.addEventListener('click', function () {
    theme = theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('schedi.theme', theme); } catch (errStore) {}
    paint(theme);
  });
})();

document.getElementById('hq-login').addEventListener('submit', async function (event) {
  event.preventDefault();
  var error = document.getElementById('hq-error');
  error.textContent = '';
  var email = document.getElementById('hq-email').value.trim().toLowerCase();
  var password = document.getElementById('hq-password').value;
  try {
    var res = await fetch('/auth/agency', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    });
    var data = {};
    try { data = await res.json(); } catch (err) { data = {}; }
    if (!res.ok || !data.session || data.role !== 'agency') {
      error.textContent = 'Those credentials were not accepted.';
      return;
    }
    try {
      localStorage.setItem('schedi.authSession', data.session);
      localStorage.setItem('schedi.authMeta', JSON.stringify({ role: 'agency', email: email, tenantId: '' }));
    } catch (errStore) {}
    location.replace('/hq');
  } catch (errNet) {
    error.textContent = 'Could not reach the sign-in service.';
  }
});
</script>
</body>
</html>
`;
}
