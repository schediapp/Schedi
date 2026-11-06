/** Short attribution token from /signup?ref=, such as demo. Anything else is dropped. */
export function signupAttributionRef(value) {
  const ref = String(value || '').trim().toLowerCase();
  return /^[a-z0-9-]{1,32}$/.test(ref) ? ref : '';
}
