const SECRET_KEY = /\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]+/g;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_KEY, "$1…");
}

export interface StripeErrorFields {
  type: string;
  message: string;
  code: string | null;
}

export function readStripeError(error: unknown): StripeErrorFields | null {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    type?: unknown;
    rawType?: unknown;
    message?: unknown;
    code?: unknown;
    requestId?: unknown;
  };
  const rawType = typeof record.rawType === "string" ? record.rawType : null;
  const typeName = typeof record.type === "string" ? record.type : null;
  const hasStripeShape = rawType != null || typeof record.requestId === "string" || typeof record.code === "string";
  if (!hasStripeShape) return null;
  const message = typeof record.message === "string" && record.message ? record.message : "Stripe rejected the request.";
  return {
    type: rawType ?? typeName ?? "StripeError",
    message: redactSecrets(message),
    code: typeof record.code === "string" && record.code ? record.code : null,
  };
}

const CODE_HINTS: Record<string, string> = {
  more_permissions_required:
    "Add Accounts v2 write (v2_account_storer_write) to the restricted key in the Stripe Dashboard, then try again.",
  secret_key_required:
    "Add Accounts v2 write (v2_account_storer_write) to the restricted key in the Stripe Dashboard, then try again.",
  connect_profile_not_submitted: "Finish the Connect platform profile in the Stripe Dashboard, then try again.",
  connect_identity_not_verified: "Finish platform identity verification in the Stripe Dashboard, then try again.",
  account_creation_liability_unacknowledged:
    "Acknowledge loss liability on the Connect platform profile in the Stripe Dashboard, then try again.",
  account_creation_requirement_collection_unacknowledged:
    "Finish the Connect platform profile in the Stripe Dashboard, then try again.",
  account_creation_requirement_collection_and_liability_unacknowledged:
    "Finish the Connect platform profile in the Stripe Dashboard, then try again.",
  account_create_activation_required: "Activate Connect for this platform in the Stripe Dashboard, then try again.",
  platform_registration_required: "Sign this platform up for Connect in the Stripe Dashboard, then try again.",
  accounts_v2_access_blocked: "Turn on Accounts v2 for this platform in the Stripe Dashboard, then try again.",
  non_connect_platform_accounts_v2_access_blocked:
    "Finish Connect setup for this platform in the Stripe Dashboard, then try again.",
  statement_descriptor_invalid:
    "The card statement descriptor on this business was rejected. Shorten the business name to plain letters and try again.",
};

function hintFor(fields: StripeErrorFields): string | null {
  if (fields.code && CODE_HINTS[fields.code]) return CODE_HINTS[fields.code];
  if (/permission|restricted (api )?key/i.test(fields.message)) {
    return CODE_HINTS.more_permissions_required;
  }
  return null;
}

export function formatConnectEnableError(error: unknown): { message: string; code?: string; log: StripeErrorFields | null } {
  const stripeError = readStripeError(error);
  if (!stripeError) {
    return { message: redactSecrets(errorMessageFallback(error)), log: null };
  }
  const codeLabel = stripeError.code ? ` (${stripeError.code})` : "";
  const hint = hintFor(stripeError);
  const message = [`Stripe could not create the connected account${codeLabel}: ${stripeError.message}`, hint]
    .filter(Boolean)
    .join(" ");
  return {
    message,
    code: stripeError.code ?? undefined,
    log: stripeError,
  };
}

function errorMessageFallback(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}
