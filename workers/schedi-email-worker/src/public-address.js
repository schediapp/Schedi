/**
 * Business profile toggle from the public booking page.
 * Missing or true shows the address. Only an explicit false hides it.
 * The dashboard uses the same rule in showPublicAddressOn.
 */
export function showPublicAddressOn(tenant) {
  return !tenant || tenant.showPublicAddress !== false;
}

export function publicBusinessAddress(tenant) {
  if (!showPublicAddressOn(tenant)) return '';
  return String((tenant && (tenant.address || tenant.location || tenant.businessAddress || tenant.businessLocation)) || '').trim();
}
