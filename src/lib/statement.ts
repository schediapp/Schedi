export interface CardStatementDescriptor {
  descriptor: string;
  prefix: string;
}

/**
 * Bank statement text for a direct charge. Stripe requires a Latin descriptor
 * of 5–22 characters and a prefix of 2–10 characters.
 */
export function cardStatementDescriptor(businessName: string): CardStatementDescriptor | null {
  const cleaned = businessName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!/[A-Z]/.test(cleaned)) return null;

  const descriptor = cleaned.slice(0, 22);
  if (descriptor.length < 5) return null;

  const prefix = descriptor.replace(/ /g, "").slice(0, 10);
  if (prefix.length < 2 || !/[A-Z]/.test(prefix)) return null;

  return { descriptor, prefix };
}

export function integrationIdentifier(label: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) suffix += alphabet[byte % alphabet.length];
  return `${label}_${suffix}`;
}

const FORBIDDEN_CHARGE_KEYS = new Set([
  "application_fee_amount",
  "application_fee_percent",
  "customer_account",
  "transfer_data",
  "on_behalf_of",
  "payment_method_types",
  "type",
]);

export function assertNoForbiddenKeys(value: unknown, path = "params"): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CHARGE_KEYS.has(key)) {
      throw new Error(`${path}.${key} is not set on this Schedi request`);
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}
