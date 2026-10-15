import {
  APEX_ORIGIN,
  MARKETING_PAGES,
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
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap";

export function canonicalUrl(path: string): string {
  if (path === "/") return `${APEX_ORIGIN}/`;
  return `${APEX_ORIGIN}${path}`;
}

export function renderRobots(): string {
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /portal",
    "Disallow: /admin",
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

export function renderMarketingBoot(): string {
  return `(() => {
  try {
    var params = new URLSearchParams(location.search);
    if (params.get("portal") === "login" || params.get("forgot") === "1" || params.get("billing")) return;
    var session = localStorage.getItem("schedi.authSession");
    var meta = localStorage.getItem("schedi.authMeta");
    if (session && meta) location.replace("/?portal=login");
  } catch (err) {}
})();
`;
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

function footer(): string {
  const verticalLinks = VERTICALS.map(
    (item) => `<a href="${item.path}">${escapeHtml(item.label)}</a>`,
  ).join(" ");
  return `<footer>
    <nav aria-label="Schedi for">
      <p>Schedi for</p>
      ${verticalLinks}
    </nav>
    <nav aria-label="Site">
      <a href="/">Home</a>
      <a href="/pricing">Pricing</a>
      <a href="/help">Help</a>
      <a href="/signup">Sign up</a>
      <a href="/terms">Terms of Service</a>
      <a href="/privacy">Privacy Policy</a>
      <a href="https://www.instagram.com/schediapp/" rel="noopener noreferrer">Instagram</a>
    </nav>
  </footer>`;
}

function faqHtml(page: MarketingPage): string {
  if (!page.faqs.length) return "";
  const items = page.faqs
    .map(
      (faq) =>
        `<h3>${escapeHtml(faq.question)}</h3><p>${escapeHtml(faq.answer)}</p>`,
    )
    .join("");
  return `<section><h2>Questions</h2>${items}</section>`;
}

const CSS = `
:root { color-scheme: dark; }
body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #06080d; color: #e2e8f0; line-height: 1.6; }
a { color: #34d399; }
header, main, footer { width: min(880px, calc(100% - 2rem)); margin: 0 auto; }
header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; padding: 1.25rem 0; }
header nav { display: flex; gap: 1rem; flex-wrap: wrap; }
.brand { font-weight: 800; color: #f8fafc; text-decoration: none; font-size: 1.25rem; }
h1 { font-size: clamp(1.8rem, 4vw, 2.6rem); line-height: 1.15; margin: 0 0 1rem; }
h2 { margin: 1.75rem 0 0.5rem; font-size: 1.25rem; }
h3 { margin: 1rem 0 0.25rem; font-size: 1.05rem; }
.hero { width: min(100%, 640px); height: auto; border-radius: 16px; margin: 0 0 1.25rem; }
.cta { display: inline-block; background: #10b981; color: #042f2e; font-weight: 800; text-decoration: none; padding: 0.75rem 1rem; border-radius: 12px; }
table { width: 100%; border-collapse: collapse; font-size: 0.95rem; margin: 1rem 0; }
th, td { border-bottom: 1px solid #1e293b; text-align: left; padding: 0.45rem 0.4rem; vertical-align: top; }
footer { padding: 2rem 0 3rem; color: #94a3b8; }
footer nav { display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; margin-top: 0.5rem; }
figure { margin: 0 0 1rem; }
figure img, figure video { max-width: 100%; height: auto; border-radius: 12px; }
`;

export function renderMarketingPage(page: MarketingPage): string {
  const canonical = canonicalUrl(page.path);
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  const hero = page.hero
    ? `<img class="hero" src="${HERO_PATH}" alt="Phone showing a Schedi booking page" width="640" height="360" fetchpriority="high" decoding="async">`
    : "";
  const heroPreload = page.hero
    ? `<link rel="preload" href="${HERO_PATH}" as="image" type="image/svg+xml" fetchpriority="high">`
    : "";
  const boot = page.portalBoot ? `<script src="/marketing-boot.js" defer></script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="index, follow">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Schedi">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${APEX_ORIGIN}${HERO_PATH}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${APEX_ORIGIN}${HERO_PATH}">
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
<header>
  <a class="brand" href="/">Schedi</a>
  <nav aria-label="Primary">
    <a href="/pricing">Pricing</a>
    <a href="/help">Help</a>
    <a class="cta" href="/signup">Sign up</a>
  </nav>
</header>
<main>
  ${hero}
  <article id="copy">
    <h1>${escapeHtml(page.h1)}</h1>
    ${page.bodyHtml}
    ${faqHtml(page)}
  </article>
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
