// Public booking document filler.
// site/booking.html is the standalone booking page. Tokens below are the only
// placeholders. Owner portal and agency code are not in that file.

export const BOOKING_ASSET_PATH = "/booking.html";

const TOKEN_SAFE_NAME = "__SCHEDI_SAFE_NAME__";
const TOKEN_HTML_CLASS = "__SCHEDI_HTML_CLASS__";
const TOKEN_META = "__SCHEDI_META_DESC__";
const TOKEN_CANONICAL = "__SCHEDI_CANONICAL__";
const TOKEN_OG = "__SCHEDI_OG_URL__";
const TOKEN_JSON_LD = "__SCHEDI_JSON_LD__";
const TOKEN_HELP = "__SCHEDI_HELP_HREF__";
const TOKEN_BADGE = "__SCHEDI_PLAN_BADGE__";
const TOKEN_INDUSTRY = "__SCHEDI_SAFE_INDUSTRY__";
const TOKEN_CONFIG = "__SCHEDI_FIREBASE_CONFIG__";
const TOKEN_APP = "__SCHEDI_APP_ID__";
const TOKEN_TENANT = "__SCHEDI_TENANT_JSON__";
const TOKEN_NEWBOOK = "__SCHEDI_NEWBOOK__";
const TOKEN_DEMO = "__SCHEDI_DEMO__";
const TOKEN_PAY_FLAG = "__SCHEDI_PAY_FLAG__";
const TOKEN_PAY_KIND = "__SCHEDI_PAY_KIND__";
const TOKEN_PAY_BOOKING = "__SCHEDI_PAY_BOOKING__";
const TOKEN_PAY_BOOKINGS = "__SCHEDI_PAY_BOOKINGS__";
const TOKEN_ANALYTICS = "__SCHEDI_ANALYTICS__";

const ADDRESS_KEYS = [
  "address",
  "location",
  "businessAddress",
  "businessLocation",
  "city",
  "businessCity",
  "state",
  "businessState",
];

const PRIVATE_KEYS = [
  "ownerName",
  "ownerEmail",
  "ownerPhone",
  "ownerPassword",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "billingExempt",
  "complimentaryPro",
  "monthlyPrice",
  "paymentForm",
  "hqTags",
  "cancelAtPeriodEnd",
  "currentPeriodEnd",
  "unpaidDigestWeek",
  "squareMerchantId",
  "squareLocationId",
  "squareLocationName",
  "squareAccountName",
  "squareConnection",
  "notificationsReplyTo",
];

const PUBLIC_WEB_CONFIG = {
  apiKey: "AIzaSyBYKvxQQGIkBNRej33pTYcqKm8G1qTPDZ0",
  authDomain: "siteforge-97699.firebaseapp.com",
  projectId: "siteforge-97699",
  storageBucket: "siteforge-97699.firebasestorage.app",
  messagingSenderId: "350589852487",
  appId: "1:350589852487:web:c7b4017d8880f0761b0a62",
};

export function isBookingDocument(html: string): boolean {
  return html.includes(TOKEN_SAFE_NAME);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function effectivePlan(fields: Record<string, unknown>): string {
  if (fields.complimentaryPro === true || fields.billingExempt === true) return "pro";
  const stored = String(fields.plan || "").toLowerCase();
  if (stored === "free" || stored === "starter" || stored === "pro") return stored;
  const price = Number(fields.monthlyPrice);
  if (price === 29 || price === 49) return "starter";
  if (price === 99) return "pro";
  return "free";
}

/** Booking-page fields only. Address is omitted when the owner hid it. */
export function projectPublicBooking(fields: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const source = fields || {};
  const pub: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (PRIVATE_KEYS.includes(key)) continue;
    pub[key] = source[key];
  }
  const notes = pub.notifications;
  if (notes && typeof notes === "object" && !Array.isArray(notes)) {
    const copy = { ...(notes as Record<string, unknown>) };
    delete copy.replyTo;
    pub.notifications = copy;
  }
  pub.plan = effectivePlan(source);
  pub.acceptingBookings = String(source.subscriptionStatus || "") !== "paused" && source.acceptingBookings !== false;
  if (source.showPublicAddress === false) {
    for (const key of ADDRESS_KEYS) delete pub[key];
  }
  return pub;
}

/**
 * Paused when acceptingBookings is false. When that flag is missing, fall back
 * to the live check: subscriptionStatus === "paused". A missing flag alone is
 * not paused.
 */
export function bookingPaused(fields: Record<string, unknown> | null | undefined): boolean {
  if (!fields) return false;
  if (fields.acceptingBookings === false) return true;
  if (!Object.prototype.hasOwnProperty.call(fields, "acceptingBookings") && String(fields.subscriptionStatus || "") === "paused") return true;
  return false;
}

function safeSlug(slug: string): string {
  return String(slug || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 80);
}

export function fillBookingDocument(
  html: string,
  input: {
    slug: string;
    fields: Record<string, unknown> | null;
    projectId?: string;
    demo?: boolean;
    jsonLd?: Record<string, unknown> | null;
  },
): string {
  const fields = input.fields || {};
  const name = String(fields.name || "Schedi").replace(/\s+/g, " ").trim() || "Schedi";
  const industry = String(fields.industry || "").replace(/\s+/g, " ").trim();
  const slug = safeSlug(input.slug || String(fields.slug || ""));
  const canonical = slug ? `https://schedi.app/${slug}` : "";
  const description = !industry || /^services?$/i.test(industry)
    ? `Book an appointment with ${name}. Live online scheduling.`
    : `Book an appointment with ${name}. ${industry} appointments with live online scheduling.`;
  const plan = effectivePlan(fields);
  const badge = plan === "free"
    ? '<span class="text-[10px] font-bold uppercase tracking-wider text-slate-200 bg-slate-800 border border-slate-600 px-2 py-1 rounded-full">Schedi</span>'
    : "";
  const help = slug
    ? `https://schedi.app/help/booking?from=${encodeURIComponent(slug)}`
    : "https://schedi.app/help/booking";
  const config = { ...PUBLIC_WEB_CONFIG };
  if (input.projectId) config.projectId = input.projectId;
  const appId = input.projectId || "siteforge-97699";
  const ld = input.jsonLd || {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name,
    ...(canonical ? { url: canonical } : {}),
  };
  const values: Record<string, string> = {
    [TOKEN_HTML_CLASS]: " schedi-newbook",
    [TOKEN_SAFE_NAME]: escapeHtml(name),
    [TOKEN_META]: escapeHtml(description),
    [TOKEN_CANONICAL]: canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : "",
    [TOKEN_OG]: canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}">` : "",
    [TOKEN_JSON_LD]: jsonForScript(ld),
    [TOKEN_HELP]: escapeHtml(help),
    [TOKEN_BADGE]: badge,
    [TOKEN_INDUSTRY]: escapeHtml(industry),
    [TOKEN_CONFIG]: jsonForScript(config),
    [TOKEN_APP]: escapeHtml(appId),
    [TOKEN_TENANT]: jsonForScript(projectPublicBooking(fields)),
    [TOKEN_NEWBOOK]: "true",
    [TOKEN_DEMO]: input.demo ? "true" : "false",
    [TOKEN_PAY_FLAG]: '""',
    [TOKEN_PAY_KIND]: '""',
    [TOKEN_PAY_BOOKING]: '""',
    [TOKEN_PAY_BOOKINGS]: '""',
    [TOKEN_ANALYTICS]: "",
  };
  let out = html;
  for (const token of Object.keys(values)) {
    if (!out.includes(token)) continue;
    out = out.split(token).join(values[token]);
  }
  return out;
}

function smallPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, follow">
<title>${escapeHtml(title)}</title>
</head>
<body>
<p>${escapeHtml(message)}</p>
</body>
</html>
`;
}

export function bookingMissingHtml(): string {
  return smallPage("Booking page not found", "This booking page is not available.");
}

export function bookingPausedHtml(name: string): string {
  const who = String(name || "This business").replace(/\s+/g, " ").trim() || "This business";
  return smallPage(`${who} is not taking appointments`, `${who} is not taking appointments right now.`);
}
