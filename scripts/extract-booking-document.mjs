// Rebuilds site/booking.html from the public booking document embedded in index.html.
// The owner shell keeps generateStandaloneHtmlForTenant for preview. Public /{slug}
// pages are served from this file, which has no owner portal and no agency code.
import { readFileSync, writeFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const fn = html.indexOf("function generateStandaloneHtmlForTenant");
if (fn < 0) throw new Error("booking generator missing");
const ret = html.indexOf("return `<!DOCTYPE html>", fn);
if (ret < 0) throw new Error("booking template missing");
const end = html.indexOf("</html>`;", ret);
if (end < 0) throw new Error("booking template end missing");
const source = html.slice(ret + "return `".length, end + "</html>".length);

const tokens = [
  ["${schediNewBook ? ' schedi-newbook' : ''}", "__SCHEDI_HTML_CLASS__"],
  ["${safeName}", "__SCHEDI_SAFE_NAME__"],
  ["${metaDesc}", "__SCHEDI_META_DESC__"],
  ["${canonicalTag}", "__SCHEDI_CANONICAL__"],
  ["${ogUrlTag}", "__SCHEDI_OG_URL__"],
  ["${jsonLd}", "__SCHEDI_JSON_LD__"],
  ["${clientHelpHref}", "__SCHEDI_HELP_HREF__"],
  ["${schediPlanBadge}", "__SCHEDI_PLAN_BADGE__"],
  ["${safeIndustry}", "__SCHEDI_SAFE_INDUSTRY__"],
  ["${configStr}", "__SCHEDI_FIREBASE_CONFIG__"],
  ["${appIdStr}", "__SCHEDI_APP_ID__"],
  ["${jsonTenant}", "__SCHEDI_TENANT_JSON__"],
  ["${schediNewBook ? 'true' : 'false'}", "__SCHEDI_NEWBOOK__"],
  ["${(typeof window !== 'undefined' && window.__SCHEDI_DEMO) ? 'true' : 'false'}", "__SCHEDI_DEMO__"],
  ["${JSON.stringify(payReturnFlag)}", "__SCHEDI_PAY_FLAG__"],
  ["${JSON.stringify(payReturnKind)}", "__SCHEDI_PAY_KIND__"],
  ["${JSON.stringify(payReturnBooking)}", "__SCHEDI_PAY_BOOKING__"],
  ["${JSON.stringify(payReturnBookings)}", "__SCHEDI_PAY_BOOKINGS__"],
  ["${schediWebAnalytics}", "__SCHEDI_ANALYTICS__"],
];

let out = "";
for (let i = 0; i < source.length; i += 1) {
  if (source.startsWith("\\${", i)) {
    out += "${";
    i += 2;
    continue;
  }
  if (source.startsWith("\\`", i)) {
    out += "`";
    i += 1;
    continue;
  }
  if (source.startsWith("<\\/", i)) {
    out += "</";
    i += 2;
    continue;
  }
  let matched = false;
  if (source[i] === "$" && source[i + 1] === "{") {
    for (const [from, token] of tokens) {
      if (source.startsWith(from, i)) {
        out += token;
        i += from.length - 1;
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error("unmapped interpolation at " + i + ": " + source.slice(i, i + 80));
    continue;
  }
  out += source[i];
}

const banned = ["renderAgencyDashboard", "assertAgencyExportPrivilege", "bootPublicOrAgency", "isAgencyHqRoute", "syncHqManagingBanner", "/auth/agency", "Complimentary"];
for (const word of banned) {
  if (out.includes(word)) throw new Error("booking document still contains " + word);
}
if (out.includes("provision")) throw new Error("booking document still contains provision");

const banner = "<!-- schedi public booking document. No owner portal and no agency code. -->\n";
writeFileSync(new URL("../site/booking.html", import.meta.url), banner + out);
console.log("wrote site/booking.html", out.length);
