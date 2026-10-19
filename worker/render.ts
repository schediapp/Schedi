import {
  APEX_ORIGIN,
  MARKETING_PAGES,
  PLAN_COMPARE_ROWS,
  VERTICALS,
  escapeHtml,
  type MarketingPage,
} from "./content";

export const HERO_PATH = "/assets/marketing/hero.svg";

export const HERO_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360" role="img" aria-labelledby="heroTitle">
  <title id="heroTitle">Booking page on a phone</title>
  <rect width="640" height="360" rx="24" fill="#0b1220"/>
  <rect x="210" y="36" width="220" height="288" rx="28" fill="#111827" stroke="#1f2937"/>
  <rect x="228" y="78" width="184" height="28" rx="8" fill="#064e3b"/>
  <rect x="228" y="122" width="184" height="44" rx="10" fill="#052e16" stroke="#10b981"/>
  <rect x="228" y="178" width="88" height="36" rx="8" fill="#1e293b"/>
  <rect x="324" y="178" width="88" height="36" rx="8" fill="#1e293b"/>
  <rect x="228" y="228" width="184" height="40" rx="10" fill="#10b981"/>
</svg>`;

const FONT_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap";

export function canonicalUrl(path: string): string {
  if (path === "/") return `${APEX_ORIGIN}/`;
  return `${APEX_ORIGIN}${path}`;
}

export function renderRobots(): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /portal",
    "Disallow: /portal-preview",
    "Disallow: /admin",
    "Disallow: /hq",
    "Disallow: /agency",
    "Disallow: /billing",
    "Disallow: /api",
    "",
    `Sitemap: ${APEX_ORIGIN}/sitemap.xml`,
    "",
  ].join("\n");
}

export function renderSitemap(): string {
  const urls = MARKETING_PAGES.map((page) => {
    const loc = escapeHtml(canonicalUrl(page.path));
    return `  <url><loc>${loc}</loc></url>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

// Theme toggle for marketing pages. Served as an external file (CSP: script-src 'self').
// Shares the app's localStorage key "schedi.theme" so the choice carries into the portal.
export const THEME_SCRIPT_PATH = "/marketing-theme.js";
export function renderMarketingTheme(): string {
  return `(function(){
var d=document.documentElement,K="schedi.theme";
function stored(){try{var v=localStorage.getItem(K);return v==="light"||v==="dark"?v:null;}catch(e){return null;}}
function sys(){try{return window.matchMedia&&window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";}catch(e){return "dark";}}
function apply(m){d.setAttribute("data-theme",m);d.classList.add("theme-js");
var c=m==="light"?"#f8fafc":"#06080d";var ms=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<ms.length;i++)ms[i].setAttribute("content",c);
var bs=document.querySelectorAll(".theme-btn");for(var j=0;j<bs.length;j++){var b=bs[j],t=m==="light"?"Switch to dark theme":"Switch to light theme";b.title=t;b.setAttribute("aria-label",t);var l=b.querySelector(".theme-btn-label");if(l)l.textContent=m==="light"?"Dark":"Light";}}
apply(stored()||sys());
function wire(){apply(d.getAttribute("data-theme")||"dark");var bs=document.querySelectorAll(".theme-btn");for(var i=0;i<bs.length;i++)bs[i].addEventListener("click",function(){var n=d.getAttribute("data-theme")==="light"?"dark":"light";try{localStorage.setItem(K,n);}catch(e){}apply(n);});}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",wire);else wire();
})();
`;
}

export function renderMarketingBoot(): string {
  // Intentionally a no-op: "/" must stay on the landing page for everyone.
  // Logged-in owners reach the portal via Log in (/login).
  return `/* no-op */\n`;
}

function jsonLd(page: MarketingPage): string {
  const graph: Record<string, unknown>[] = [];
  if (page.faqs.length) {
    graph.push({
      "@type": "FAQPage",
      mainEntity: page.faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer },
      })),
    });
  }
  if (page.softwareJsonLd) {
    graph.push({
      "@type": "Organization",
      name: "Schedi",
      url: `${APEX_ORIGIN}/`,
      logo: `${APEX_ORIGIN}/assets/logo-dark.svg`,
      email: "hello@schedi.app",
      sameAs: ["https://www.instagram.com/schediapp/"],
    });
    graph.push({
      "@type": "SoftwareApplication",
      name: "Schedi",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      url: `${APEX_ORIGIN}/`,
      offers: [
        { "@type": "Offer", name: "Free", price: "0", priceCurrency: "USD" },
        {
          "@type": "Offer",
          name: "Starter",
          price: "29",
          priceCurrency: "USD",
          description: "Billed monthly",
        },
        {
          "@type": "Offer",
          name: "Pro",
          price: "49",
          priceCurrency: "USD",
          description: "Billed monthly. Adds client card payments and deposits.",
        },
      ],
    });
  }
  if (!graph.length) return "";
  const payload = { "@context": "https://schema.org", "@graph": graph };
  return `<script type="application/ld+json">${JSON.stringify(payload).replace(/</g, "\\u003c")}</script>`;
}

const LOGIN_HREF = "/login";
export const OG_IMAGE = "https://schedi.app/assets/og/schedi-og.png";
const OG_IMAGE_ALT = "Schedi logo. Booking pages for service businesses.";

function icon(name: string): string {
  const paths: Record<string, string> = {
    link: '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="3"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m9 16 2 2 4-4"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    wallet: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20"/><path d="M16 15h2"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    phone: '<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
    minus: '<path d="M5 12h14"/>',
  };
  return `<svg class="ico" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ""}</svg>`;
}

function siteHeader(): string {
  return `<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="/" aria-label="Schedi home">
      <img class="logo-dark" src="/assets/logo-dark.svg" alt="Schedi" width="120" height="32" loading="lazy" decoding="async">
      <img class="logo-light" src="/assets/logo-light.svg" alt="Schedi" width="120" height="32" loading="lazy" decoding="async">
    </a>
    <nav class="nav" aria-label="Primary">
      <a class="nav-link" href="/pricing">Pricing</a>
      <a class="nav-link" href="/help">Help</a>
      <button type="button" class="theme-btn" title="Switch theme" aria-label="Switch theme"><svg class="ico i-sun" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg><svg class="ico i-moon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg><span class="theme-btn-label">Light</span></button>
      <a class="btn btn-ghost btn-sm login" href="${LOGIN_HREF}">${icon("login")}<span>Log in</span></a>
      <a class="btn btn-primary btn-sm" href="/signup"><span class="hide-xs">Get started free</span><span class="show-xs">Sign up</span></a>
    </nav>
  </div>
</header>`;
}

function footer(): string {
  const verticalLinks = VERTICALS.map(
    (item) => `<a href="${item.path}">${escapeHtml(item.label)}</a>`,
  ).join(" ");
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="foot-top">
      <div>
        <img class="foot-logo logo-dark" src="/assets/logo-dark.svg" alt="Schedi" width="110" height="30" loading="lazy"><img class="foot-logo logo-light" src="/assets/logo-light.svg" alt="Schedi" width="110" height="30" loading="lazy">
        <p class="muted">Simple online booking for small service businesses.</p>
      </div>
      <nav aria-label="Schedi for">
        <p>Schedi for</p>
        ${verticalLinks}
      </nav>
      <nav aria-label="Site">
        <p>Schedi</p>
        <a href="/">Home</a>
        <a href="/pricing">Pricing</a>
        <a href="/help">Help</a>
        <a href="/signup">Sign up</a>
        <a href="${LOGIN_HREF}">Log in</a>
        <a href="/terms">Terms of Service</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="https://www.instagram.com/schediapp/" rel="noopener noreferrer">Instagram</a>
      </nav>
    </div>
    <p class="muted small">&copy; Schedi. Made for barbers, salons, cleaners, trainers, and every small team that runs on appointments.</p>
  </div>
</footer>`;
}

function faqHtml(page: MarketingPage): string {
  if (!page.faqs.length) return "";
  const items = page.faqs
    .map(
      (faq) =>
        `<details class="faq"><summary><h3>${escapeHtml(faq.question)}</h3></summary><p>${escapeHtml(faq.answer)}</p></details>`,
    )
    .join("");
  return `<section class="faqs"><h2>Questions</h2>${items}</section>`;
}

type PlanKey = "free" | "starter" | "pro";
const PLANS: { key: PlanKey; name: string; blurb: string; cta: string; popular?: boolean }[] = [
  { key: "free", name: "Free", blurb: "Try Schedi with one service and get your link today.", cta: "Start free" },
  { key: "starter", name: "Starter", blurb: "For growing businesses that take Cash App, Venmo, Zelle, or PayPal.", cta: "Choose Starter" },
  { key: "pro", name: "Pro", blurb: "Take cards and deposits, and set up repeating visits.", cta: "Choose Pro", popular: true },
];

export function planCardsHtml(): string {
  const price = PLAN_COMPARE_ROWS[0];
  const rows = PLAN_COMPARE_ROWS.slice(1);
  const cards = PLANS.map((plan) => {
    const items = rows
      .map((row) => {
        const v = row[plan.key];
        const label = escapeHtml(row.label);
        if (v === "No") return `<li class="off">${icon("minus")}<span>${label}</span></li>`;
        if (v === "Yes") return `<li>${icon("check")}<span>${label}</span></li>`;
        return `<li>${icon("check")}<span>${label}: <strong>${escapeHtml(v)}</strong></span></li>`;
      })
      .join("");
    const amount = escapeHtml(price[plan.key]);
    return `<article class="plan${plan.popular ? " popular" : ""}" aria-label="${plan.name} plan">
      ${plan.popular ? '<p class="badge">Most popular</p>' : ""}
      <h3>${plan.name}</h3>
      <p class="price"><span class="amt">${amount}</span><span class="per">${plan.key === "free" ? "forever" : "/ month"}</span></p>
      <p class="blurb">${escapeHtml(plan.blurb)}</p>
      <a class="btn ${plan.popular ? "btn-primary" : "btn-ghost"} btn-block" href="/signup">${plan.cta}</a>
      <ul class="feat">${items}</ul>
    </article>`;
  }).join("\n");
  return `<div class="plans">${cards}</div>
  <p class="muted center small">Monthly prices. Upgrade, switch, or stay on Free anytime from your Business Portal. Nothing is charged until checkout finishes.</p>`;
}

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: "link", title: "One link for everything", text: "Share schedi.app/your-business in your bio, a text, or on a printed QR code." },
  { icon: "calendar", title: "Open times, always current", text: "Set your hours once. Clients only see times you're actually free." },
  { icon: "bell", title: "Reminder emails", text: "Clients get a friendly reminder the morning of their visit, so fewer no-shows." },
  { icon: "wallet", title: "Get paid your way", text: "Pay at the appointment, Cash App, Venmo, Zelle, PayPal, or cards on Pro." },
  { icon: "repeat", title: "Repeating visits", text: "Weekly, biweekly, or monthly regulars book once on Pro." },
  { icon: "shield", title: "You stay in control", text: "Accept or decline new requests, and keep every booking in one place." },
];

function phoneMock(): string {
  return `<div class="mock" aria-hidden="true">
    <div class="phone">
      <div class="ph-top"><span class="dot"></span><span class="ph-title">Fresh Cuts Studio</span></div>
      <p class="ph-label">Choose a service</p>
      <div class="ph-svc active"><span>Classic cut</span><span>45 min</span></div>
      <div class="ph-svc"><span>Beard trim</span><span>20 min</span></div>
      <p class="ph-label">Pick a time</p>
      <div class="ph-times"><span>9:00</span><span class="on">10:30</span><span>1:15</span><span>3:00</span></div>
      <div class="ph-btn">Book appointment</div>
    </div>
    <div class="toast">${icon("check")}<div><strong>New booking</strong><span>Tue 10:30 · Classic cut</span></div></div>
  </div>`;
}

function homeSections(page: MarketingPage): string {
  const features = FEATURES.map(
    (f) => `<div class="card feature"><span class="ico-wrap">${icon(f.icon)}</span><h3>${f.title}</h3><p>${f.text}</p></div>`,
  ).join("");
  return `<section class="hero-sec">
    <div class="wrap hero-grid">
      <div class="hero-copy">
        <p class="eyebrow">${icon("calendar")}<span>Online booking for service businesses</span></p>
        <h1>${escapeHtml(page.h1)}</h1>
        <p class="lede">${escapeHtml(page.lede || "")}</p>
        <div class="ctas">
          <a class="btn btn-primary btn-lg" href="/signup">Create your booking page</a>
          <a class="btn btn-ghost btn-lg" href="/pricing">See pricing</a>
        </div>
        <ul class="trust">
          <li>${icon("check")}Free plan, $0</li>
          <li>${icon("check")}Set up in minutes</li>
          <li>${icon("check")}Works on any phone</li>
        </ul>
      </div>
      ${phoneMock()}
    </div>
  </section>
  <section class="sec">
    <div class="wrap">
      <p class="kicker">Why Schedi</p>
      <h2 class="sec-title">Everything you need to fill your calendar</h2>
      <div class="grid3">${features}</div>
    </div>
  </section>
  <section class="sec alt">
    <div class="wrap">
      <p class="kicker">How it works</p>
      <h2 class="sec-title">Up and running in three steps</h2>
      <ol class="steps">
        <li class="card"><span class="num">1</span><h3>Create your page</h3><p>Sign up free and get a link like schedi.app/your-business.</p></li>
        <li class="card"><span class="num">2</span><h3>Add services and hours</h3><p>List what you offer, how long it takes, and when you work.</p></li>
        <li class="card"><span class="num">3</span><h3>Share your link</h3><p>Clients pick a time. You see it in your Business Portal right away.</p></li>
      </ol>
    </div>
  </section>
  <section class="sec" id="plans">
    <div class="wrap">
      <p class="kicker">Pricing</p>
      <h2 class="sec-title">Start free. Upgrade when you're ready.</h2>
      ${planCardsHtml()}
      <p class="center"><a href="/pricing">Compare every feature &rarr;</a></p>
    </div>
  </section>`;
}

function pricingSections(page: MarketingPage): string {
  return `<section class="hero-sec slim">
    <div class="wrap center">
      <p class="eyebrow">${icon("wallet")}<span>Pricing</span></p>
      <h1>${escapeHtml(page.h1)}</h1>
      <p class="lede">${escapeHtml(page.lede || "")}</p>
    </div>
  </section>
  <section class="sec tight">
    <div class="wrap">${planCardsHtml()}</div>
  </section>`;
}

function ctaBand(): string {
  return `<section class="sec">
    <div class="wrap">
      <div class="band">
        <div><h2>Ready to stop booking by text?</h2><p>Create your free booking page in a few minutes.</p></div>
        <div class="ctas">
          <a class="btn btn-primary btn-lg" href="/signup">Get started free</a>
          <a class="btn btn-ghost btn-lg" href="${LOGIN_HREF}">Log in</a>
        </div>
      </div>
    </div>
  </section>`;
}

const CSS = `
:root{color-scheme:dark;--bg:#06080d;--bg2:#0b111c;--card:#0f1724;--line:#1e293b;--text:#e2e8f0;--head:#f8fafc;--muted:#94a3b8;--brand:#10b981;--brand2:#34d399;--brand-ink:#04130d;--brand-soft:rgba(16,185,129,.12);--shadow:0 20px 50px -24px rgba(0,0,0,.7)}
@media (prefers-color-scheme:light){:root{color-scheme:light;--bg:#f8fafc;--bg2:#eef7f3;--card:#ffffff;--line:#e2e8f0;--text:#334155;--head:#0f172a;--muted:#64748b;--brand:#047857;--brand2:#065f46;--brand-ink:#ffffff;--brand-soft:rgba(16,185,129,.1);--shadow:0 20px 40px -24px rgba(15,23,42,.25)}}
:root[data-theme=light]{color-scheme:light;--bg:#f8fafc;--bg2:#eef7f3;--card:#ffffff;--line:#e2e8f0;--text:#334155;--head:#0f172a;--muted:#64748b;--brand:#047857;--brand2:#065f46;--brand-ink:#ffffff;--brand-soft:rgba(16,185,129,.1);--shadow:0 20px 40px -24px rgba(15,23,42,.25)}
:root[data-theme=dark]{color-scheme:dark;--bg:#06080d;--bg2:#0b111c;--card:#0f1724;--line:#1e293b;--text:#e2e8f0;--head:#f8fafc;--muted:#94a3b8;--brand:#10b981;--brand2:#34d399;--brand-ink:#04130d;--brand-soft:rgba(16,185,129,.12);--shadow:0 20px 50px -24px rgba(0,0,0,.7)}
.logo-light{display:none}
@media (prefers-color-scheme:light){.logo-dark{display:none}.logo-light{display:inline}}
:root[data-theme=dark] .logo-dark{display:inline}:root[data-theme=dark] .logo-light{display:none}
:root[data-theme=light] .logo-dark{display:none}:root[data-theme=light] .logo-light{display:inline}
.theme-btn{display:none;align-items:center;justify-content:center;gap:.35rem;padding:.375rem .7rem;min-height:2rem;border-radius:.75rem;font:inherit;font-size:.75rem;font-weight:700;line-height:1.2;cursor:pointer;transition:background-color .15s,color .15s,border-color .15s;background:#ffffff;color:#0f172a;border:1px solid #d7dee8;box-shadow:0 1px 2px rgba(15,23,42,.08)}
.theme-js .theme-btn{display:inline-flex}
.theme-btn:hover{background:#f4f7fb;border-color:#cbd5e1;color:#020617}
.theme-btn:focus-visible{outline:2px solid #10b981;outline-offset:2px}
.theme-btn .ico{width:.9rem;height:.9rem}.theme-btn .i-moon{display:none}
:root[data-theme=light] .theme-btn{background:#0f172a;color:#f1f5f9;border-color:#334155;box-shadow:none}
:root[data-theme=light] .theme-btn:hover{background:#1e293b;border-color:#475569;color:#fff}
:root[data-theme=light] .theme-btn .i-sun{display:none}:root[data-theme=light] .theme-btn .i-moon{display:inline}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);line-height:1.6;overflow-x:hidden}
a{color:var(--brand2)}
img{max-width:100%}
.wrap{width:min(1120px,calc(100% - 2.5rem));margin:0 auto}
h1,h2,h3{color:var(--head);letter-spacing:-.02em}
h1{font-size:clamp(2.1rem,5.4vw,3.6rem);line-height:1.08;margin:0 0 1rem;font-weight:800}
h2{font-size:clamp(1.5rem,3vw,2.1rem);line-height:1.2;margin:2rem 0 .75rem;font-weight:800}
h3{font-size:1.1rem;margin:1rem 0 .3rem;font-weight:700}
.muted{color:var(--muted)}.small{font-size:.875rem}.center{text-align:center}
.ico{width:1.15em;height:1.15em;flex:none}
.site-header{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.4) blur(12px);-webkit-backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid var(--line)}
.bar{display:flex;justify-content:space-between;align-items:center;gap:.75rem;min-height:64px}
.brand{display:flex;align-items:center;flex:none}.brand img{height:32px;width:auto;display:block}
.nav{display:flex;align-items:center;gap:.4rem}
.nav-link{color:var(--text);text-decoration:none;font-weight:600;font-size:.95rem;padding:.5rem .7rem;border-radius:10px}
.nav-link:hover{background:var(--brand-soft);color:var(--head)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:.45rem;font-weight:700;text-decoration:none;border-radius:12px;padding:.75rem 1.15rem;border:1px solid transparent;transition:transform .15s,background .15s,border-color .15s;white-space:nowrap;font-size:1rem}
.btn:hover{transform:translateY(-1px)}
.btn:focus-visible,.nav-link:focus-visible{outline:3px solid var(--brand2);outline-offset:2px}
.btn-primary{background:var(--brand);color:var(--brand-ink);box-shadow:0 10px 24px -12px rgba(16,185,129,.8)}
.btn-primary:hover{background:var(--brand2)}
.btn-ghost{background:transparent;color:var(--head);border-color:var(--line)}
.btn-ghost:hover{border-color:var(--brand);background:var(--brand-soft)}
.btn-sm{padding:.5rem .85rem;font-size:.9rem;border-radius:10px}
.btn-lg{padding:.9rem 1.4rem;font-size:1.05rem}
.btn-block{width:100%}
.show-xs{display:none}
.hero-sec{padding:4.5rem 0 3.5rem;background:radial-gradient(900px 420px at 85% -10%,rgba(16,185,129,.18),transparent 60%),radial-gradient(700px 380px at -10% 10%,rgba(56,189,248,.08),transparent 60%)}
.hero-sec.slim{padding:3.5rem 0 1.5rem}
.hero-sec.slim .lede{margin-left:auto;margin-right:auto}
.hero-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:3rem;align-items:center}
.eyebrow{display:inline-flex;align-items:center;gap:.45rem;margin:0 0 1.1rem;padding:.35rem .8rem;border-radius:999px;background:var(--brand-soft);color:var(--brand2);font-weight:700;font-size:.85rem;border:1px solid color-mix(in srgb,var(--brand) 35%,transparent)}
.lede{font-size:clamp(1.05rem,1.6vw,1.2rem);color:var(--muted);max-width:36rem;margin:0 0 1.75rem}
.ctas{display:flex;flex-wrap:wrap;gap:.75rem}
.trust{list-style:none;padding:0;margin:1.5rem 0 0;display:flex;flex-wrap:wrap;gap:.5rem 1.25rem;color:var(--muted);font-size:.92rem}
.trust li{display:flex;align-items:center;gap:.35rem}.trust .ico{color:var(--brand2)}
.mock{position:relative;display:flex;justify-content:center}
.phone{width:min(300px,100%);background:var(--card);border:1px solid var(--line);border-radius:32px;padding:1.25rem 1.1rem 1.4rem;box-shadow:var(--shadow)}
.ph-top{display:flex;align-items:center;gap:.6rem;margin-bottom:1rem}
.dot{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,var(--brand),#0ea5e9)}
.ph-title{font-weight:800;color:var(--head)}
.ph-label{font-size:.75rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:.8rem 0 .45rem}
.ph-svc{display:flex;justify-content:space-between;padding:.65rem .8rem;border:1px solid var(--line);border-radius:12px;margin-bottom:.45rem;font-size:.9rem}
.ph-svc span:last-child{color:var(--muted)}
.ph-svc.active{border-color:var(--brand);background:var(--brand-soft);color:var(--head);font-weight:600}
.ph-times{display:grid;grid-template-columns:repeat(4,1fr);gap:.4rem}
.ph-times span{text-align:center;padding:.5rem 0;border:1px solid var(--line);border-radius:10px;font-size:.85rem}
.ph-times .on{background:var(--brand);color:var(--brand-ink);border-color:var(--brand);font-weight:700}
.ph-btn{margin-top:1rem;text-align:center;background:var(--brand);color:var(--brand-ink);font-weight:800;padding:.75rem;border-radius:12px}
.toast{position:absolute;left:0;bottom:1.5rem;display:flex;gap:.6rem;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:.7rem .9rem;box-shadow:var(--shadow);font-size:.85rem}
.toast .ico{color:var(--brand-ink);background:var(--brand);border-radius:999px;padding:4px;width:26px;height:26px}
.toast strong{display:block;color:var(--head)}.toast span{color:var(--muted)}
.sec{padding:4rem 0}.sec.tight{padding:1rem 0 3rem}
.sec.alt{background:var(--bg2);border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.kicker{margin:0;color:var(--brand2);font-weight:800;text-transform:uppercase;letter-spacing:.08em;font-size:.8rem;text-align:center}
.sec-title{text-align:center;margin:.4rem auto 2.25rem;max-width:40rem}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:1.1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:1.4rem}
.feature h3{margin-top:.9rem}.feature p,.steps p{margin:0;color:var(--muted)}
.ico-wrap{display:inline-flex;padding:.6rem;border-radius:12px;background:var(--brand-soft);color:var(--brand2)}
.steps{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:1.1rem}
.num{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:999px;background:var(--brand);color:var(--brand-ink);font-weight:800}
.plans{display:grid;grid-template-columns:repeat(3,1fr);gap:1.1rem;align-items:stretch;margin-bottom:1.25rem}
.plan{position:relative;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:1.6rem 1.4rem;display:flex;flex-direction:column}
.plan.popular{border:2px solid var(--brand);box-shadow:0 24px 60px -28px rgba(16,185,129,.55)}
.plan h3{margin:0;font-size:1.25rem}
.badge{position:absolute;top:-.8rem;left:50%;transform:translateX(-50%);margin:0;background:var(--brand);color:var(--brand-ink);font-weight:800;font-size:.75rem;padding:.25rem .75rem;border-radius:999px;white-space:nowrap}
.price{margin:.6rem 0 .3rem;display:flex;align-items:baseline;gap:.35rem}
.amt{font-size:2.6rem;font-weight:800;color:var(--head);letter-spacing:-.03em;line-height:1}
.per{color:var(--muted);font-weight:600}
.blurb{color:var(--muted);margin:0 0 1.2rem;min-height:3.2em}
.feat{list-style:none;padding:0;margin:1.3rem 0 0;display:grid;gap:.55rem;font-size:.93rem}
.feat li{display:flex;gap:.5rem;align-items:flex-start}
.feat li .ico{color:var(--brand2);margin-top:.15rem}
.feat li.off{color:var(--muted);opacity:.65}.feat li.off .ico{color:var(--muted)}
.band{display:flex;justify-content:space-between;align-items:center;gap:1.5rem;flex-wrap:wrap;padding:2.25rem;border-radius:24px;background:linear-gradient(135deg,rgba(16,185,129,.18),rgba(14,165,233,.08));border:1px solid color-mix(in srgb,var(--brand) 40%,transparent)}
.band h2{margin:0 0 .3rem}.band p{margin:0;color:var(--muted)}
#copy{max-width:760px;margin:0 auto;padding:1rem 0 2rem}
#copy section{margin-top:1.5rem}
#copy ol{padding-left:1.25rem}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:16px;margin:1.25rem 0;background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:.92rem}
caption{text-align:left;padding:1rem 1rem .25rem;font-weight:800;color:var(--head)}
th,td{border-bottom:1px solid var(--line);text-align:left;padding:.7rem .8rem;vertical-align:top}
tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}
thead th{color:var(--muted);font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
tbody th{font-weight:600;color:var(--head)}
.faqs{margin-top:2rem}
.faq{border:1px solid var(--line);border-radius:14px;background:var(--card);padding:0 1.1rem;margin:.6rem 0}
.faq summary{cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;gap:1rem}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:"+";font-size:1.4rem;color:var(--brand2);font-weight:700}
.faq[open] summary::after{content:"\\2212"}
.faq h3{margin:.9rem 0;font-size:1rem}
.faq p{margin:0 0 1rem;color:var(--muted)}
.plain{padding:2.5rem 0 1rem}
.hero{width:min(100%,640px);height:auto;border-radius:16px;margin:0 0 1.25rem}
figure{margin:0 0 1rem}
figure img,figure video{max-width:100%;height:auto;border-radius:12px}
.help-clip-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:1rem;align-items:start}
.help-clip-grid figure{margin:0}
.help-clip-grid video{width:100%;aspect-ratio:9/16;object-fit:cover;background:#020617;border-radius:12px;display:block}
.help-clip-grid figcaption{margin-top:.45rem;font-size:.86rem;color:var(--muted)}
.site-footer{border-top:1px solid var(--line);padding:3rem 0 2.5rem;color:var(--muted);margin-top:2rem}
.foot-top{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:2rem;margin-bottom:1.5rem}
.foot-logo{height:30px;width:auto}
.site-footer nav{display:flex;flex-direction:column;gap:.45rem}
.site-footer nav p{margin:0 0 .25rem;font-weight:800;color:var(--head)}
.site-footer a{color:var(--muted);text-decoration:none}.site-footer a:hover{color:var(--brand2)}
@media (max-width:900px){.hero-grid{grid-template-columns:1fr;gap:2.5rem}.grid3,.steps{grid-template-columns:1fr 1fr}.plans{grid-template-columns:1fr;max-width:460px;margin-left:auto;margin-right:auto}.plan.popular{order:-1}.blurb{min-height:0}.foot-top{grid-template-columns:1fr 1fr}.foot-top>div:first-child{grid-column:1/-1}}
@media (max-width:640px){.wrap{width:calc(100% - 2rem)}.nav-link{display:none}.hero-sec{padding:2.5rem 0 2.5rem}.grid3,.steps{grid-template-columns:1fr}.ctas .btn{flex:1 1 100%}.sec{padding:3rem 0}.band{padding:1.5rem}.toast{left:.25rem;bottom:.5rem}th,td{padding:.55rem .5rem}table{font-size:.82rem}}
@media (max-width:400px){.theme-btn{padding:.375rem .5rem}.theme-btn-label{display:none}.hide-xs{display:none}.show-xs{display:inline}.brand img{height:28px}.btn-sm{padding:.48rem .7rem;font-size:.86rem}.login .ico{display:none}.bar{gap:.4rem}}
`;

export function renderMarketingPage(page: MarketingPage): string {
  const canonical = canonicalUrl(page.path);
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  const rich = page.layout === "home" || page.layout === "pricing";
  const hero = page.hero && !rich
    ? `<img class="hero" src="${HERO_PATH}" alt="Phone showing a Schedi booking page" width="640" height="360" fetchpriority="high" decoding="async">`
    : "";
  const heroPreload = page.hero && !rich
    ? `<link rel="preload" href="${HERO_PATH}" as="image" type="image/svg+xml" fetchpriority="high">`
    : `<link rel="preload" href="/assets/logo-dark.svg" as="image" type="image/svg+xml">`;
  const boot = page.portalBoot ? `<script src="/marketing-boot.js" defer></script>` : "";
  let mainHtml: string;
  if (page.layout === "home") {
    mainHtml = `${homeSections(page)}
  <div class="wrap"><article id="copy">
    <h2>More about Schedi</h2>
    ${page.bodyHtml}
    ${faqHtml(page)}
  </article></div>
  ${ctaBand()}`;
  } else if (page.layout === "pricing") {
    mainHtml = `${pricingSections(page)}
  <div class="wrap"><article id="copy">
    ${page.bodyHtml}
    ${faqHtml(page)}
  </article></div>
  ${ctaBand()}`;
  } else {
    mainHtml = `<div class="wrap plain">
  ${hero}
  <article id="copy">
    <h1>${escapeHtml(page.h1)}</h1>
    ${page.bodyHtml}
    ${faqHtml(page)}
  </article>
  </div>`;
  }
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script src="${THEME_SCRIPT_PATH}"></script>
<meta name="theme-color" content="#06080d" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#f8fafc" media="(prefers-color-scheme: light)">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Schedi">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:type" content="image/png">
<meta property="og:image:alt" content="${OG_IMAGE_ALT}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${OG_IMAGE}">
<meta name="twitter:image:alt" content="${OG_IMAGE_ALT}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="preload" href="${FONT_STYLESHEET}" as="style">
<link rel="stylesheet" href="${FONT_STYLESHEET}">
${heroPreload}
<link rel="icon" href="/assets/homescreen-icon.png" type="image/png">
<style>${CSS}</style>
${jsonLd(page)}
</head>
<body>
${siteHeader()}
<main>
  ${mainHtml}
</main>
${footer()}
${boot}
</body>
</html>
`;
}

export function renderNotFound(): string {
  const title = "Page not found | Schedi";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="robots" content="noindex, follow">
<link rel="canonical" href="${APEX_ORIGIN}/">
</head>
<body>
<main>
  <h1>Page not found</h1>
  <p>That page is not on Schedi. Visit the <a href="/">home page</a> or <a href="/pricing">pricing</a>.</p>
</main>
</body>
</html>
`;
}

export function copyWordCount(html: string): number {
  const match = html.match(/<article id="copy">([\s\S]*?)<\/article>/);
  const inner = match ? match[1] : "";
  const text = inner
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}
