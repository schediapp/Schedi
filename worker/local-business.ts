// LocalBusiness JSON-LD built only from fields present on the tenant.
// Missing address, city, and prices are omitted. Nothing is invented.

export type TenantService = { name: string; price?: number };

export type TenantSeo = {
  name: string;
  industry: string;
  slug: string;
  seoPublic: boolean;
  timezone?: string;
  streetAddress?: string;
  city?: string;
  region?: string;
  services: TenantService[];
};

type FirestoreValue = Record<string, unknown>;

function decodeFirestore(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const field = value as FirestoreValue;
  if ("nullValue" in field) return null;
  if (typeof field.stringValue === "string") return field.stringValue;
  if (typeof field.booleanValue === "boolean") return field.booleanValue;
  if (typeof field.integerValue === "string" || typeof field.integerValue === "number") {
    return Number(field.integerValue);
  }
  if (typeof field.doubleValue === "number") return field.doubleValue;
  if (field.arrayValue && typeof field.arrayValue === "object") {
    const values = (field.arrayValue as { values?: unknown[] }).values || [];
    return values.map((item) => decodeFirestore(item));
  }
  if (field.mapValue && typeof field.mapValue === "object") {
    const fields = (field.mapValue as { fields?: Record<string, unknown> }).fields || {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) out[key] = decodeFirestore(fields[key]);
    return out;
  }
  return undefined;
}

function text(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function priceOf(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 100) / 100;
}

export function decodeFirestoreFields(document: unknown): Record<string, unknown> | null {
  if (!document || typeof document !== "object") return null;
  const fields = (document as { fields?: Record<string, unknown> }).fields;
  if (!fields) return null;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields)) out[key] = decodeFirestore(fields[key]);
  return out;
}

export function tenantFromFirestore(document: unknown): TenantSeo | null {
  if (!document || typeof document !== "object") return null;
  const fields = (document as { fields?: Record<string, unknown> }).fields;
  if (!fields) return null;
  const name = text(decodeFirestore(fields.name));
  if (!name) return null;
  const seo = fields.seoPublic as { booleanValue?: unknown } | undefined;
  const servicesRaw = decodeFirestore(fields.services);
  const services: TenantService[] = [];
  if (Array.isArray(servicesRaw)) {
    for (const item of servicesRaw) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const serviceName = text(record.name);
      if (!serviceName) continue;
      const price = priceOf(record.price);
      services.push(price === undefined ? { name: serviceName } : { name: serviceName, price });
    }
  }
  const showPublicAddress = decodeFirestore(fields.showPublicAddress) !== false;
  const street = showPublicAddress
    ? text(
        decodeFirestore(fields.address),
        decodeFirestore(fields.location),
        decodeFirestore(fields.businessAddress),
        decodeFirestore(fields.businessLocation),
      )
    : "";
  const city = showPublicAddress ? text(decodeFirestore(fields.city), decodeFirestore(fields.businessCity)) : "";
  const region = showPublicAddress ? text(decodeFirestore(fields.state), decodeFirestore(fields.businessState)) : "";
  const timezone = text(decodeFirestore(fields.timezone), decodeFirestore(fields.timeZone));
  const tenant: TenantSeo = {
    name,
    industry: text(decodeFirestore(fields.industry)),
    slug: text(decodeFirestore(fields.slug)).toLowerCase(),
    seoPublic: !!(seo && seo.booleanValue === true),
    services,
  };
  if (timezone) tenant.timezone = timezone;
  if (street) tenant.streetAddress = street;
  if (city) tenant.city = city;
  if (region) tenant.region = region;
  return tenant;
}

export function localBusinessJsonLd(tenant: TenantSeo, canonical: string): Record<string, unknown> {
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: tenant.name,
    url: canonical,
  };
  const address: Record<string, unknown> = { "@type": "PostalAddress" };
  if (tenant.streetAddress) address.streetAddress = tenant.streetAddress;
  if (tenant.city) address.addressLocality = tenant.city;
  if (tenant.region) address.addressRegion = tenant.region;
  if (Object.keys(address).length > 1) data.address = address;
  if (tenant.services.length) {
    data.hasOfferCatalog = {
      "@type": "OfferCatalog",
      name: "Services",
      itemListElement: tenant.services.map((service) => {
        const offer: Record<string, unknown> = {
          "@type": "Offer",
          itemOffered: { "@type": "Service", name: service.name },
        };
        if (service.price !== undefined) {
          offer.price = String(service.price);
          offer.priceCurrency = "USD";
        }
        return offer;
      }),
    };
  }
  return data;
}

export function localBusinessScript(tenant: TenantSeo, canonical: string): string {
  const json = JSON.stringify(localBusinessJsonLd(tenant, canonical)).replace(/</g, "\\u003c");
  return `<script type="application/ld+json">${json}</script>`;
}
