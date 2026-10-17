// Structural checks for the schema.org types Schedi emits.
// CI uses this so every JSON-LD block is validated without a network call.

export type JsonLdIssue = { path: string; message: string };

const CONTEXT = new Set(["https://schema.org", "http://schema.org", "https://schema.org/"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function typeOf(node: Record<string, unknown>): string {
  const value = node["@type"];
  return typeof value === "string" ? value : "";
}

function issuesFor(node: unknown, path: string, out: JsonLdIssue[]): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => issuesFor(item, `${path}[${index}]`, out));
    return;
  }
  if (!isObject(node)) return;
  const type = typeOf(node);
  const need = (key: string) => {
    if (node[key] === undefined || node[key] === null || node[key] === "") {
      out.push({ path: `${path}.${key}`, message: `${type || "node"} is missing ${key}` });
    }
  };
  if (type === "Offer") {
    if (!node.itemOffered) need("price");
    if (node.price !== undefined && node.price !== "") {
      need("priceCurrency");
      if (node.priceCurrency !== undefined && node.priceCurrency !== "USD") {
        out.push({ path: `${path}.priceCurrency`, message: "Offer priceCurrency must be USD" });
      }
    }
  }
  if (type === "UnitPriceSpecification") {
    need("price");
    need("priceCurrency");
    need("unitCode");
    if (node.priceCurrency !== undefined && node.priceCurrency !== "USD") {
      out.push({ path: `${path}.priceCurrency`, message: "UnitPriceSpecification priceCurrency must be USD" });
    }
    if (node.unitCode !== undefined && node.unitCode !== "MON") {
      out.push({ path: `${path}.unitCode`, message: "monthly UnitPriceSpecification uses unitCode MON" });
    }
  }
  if (type === "SoftwareApplication") {
    need("name");
    need("offers");
  }
  if (type === "Organization") {
    need("name");
    need("url");
    need("logo");
  }
  if (type === "FAQPage") need("mainEntity");
  if (type === "Question") {
    need("name");
    need("acceptedAnswer");
  }
  if (type === "Answer") need("text");
  if (type === "LocalBusiness") need("name");
  if (type === "OfferCatalog") need("itemListElement");
  if (type === "PostalAddress") {
    const has =
      node.streetAddress || node.addressLocality || node.addressRegion || node.postalCode || node.addressCountry;
    if (!has) out.push({ path, message: "PostalAddress has no address fields" });
  }
  if (type === "Service") need("name");
  for (const key of Object.keys(node)) {
    if (key === "@context" || key === "@type") continue;
    issuesFor(node[key], `${path}.${key}`, out);
  }
}

export function extractJsonLd(html: string): unknown[] {
  const blocks: unknown[] = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    blocks.push(JSON.parse(match[1]));
  }
  return blocks;
}

export function validateJsonLd(data: unknown): JsonLdIssue[] {
  const out: JsonLdIssue[] = [];
  if (!isObject(data)) {
    out.push({ path: "$", message: "JSON-LD root must be an object" });
    return out;
  }
  const context = data["@context"];
  if (typeof context !== "string" || !CONTEXT.has(context)) {
    out.push({ path: "$.@context", message: "JSON-LD @context must be https://schema.org" });
  }
  if (!data["@type"] && !Array.isArray(data["@graph"])) {
    out.push({ path: "$", message: "JSON-LD needs @type or @graph" });
  }
  issuesFor(data, "$", out);
  return out;
}

export function assertJsonLdDocuments(html: string): JsonLdIssue[] {
  const blocks = extractJsonLd(html);
  if (!blocks.length) return [{ path: "$", message: "page has no JSON-LD" }];
  return blocks.flatMap((block) => validateJsonLd(block));
}
