// Chrome applies form-action to every hop of a form navigation, including 303s.
// POST /api/billing and POST /api/bookings answer on this origin, then redirect
// to Stripe Checkout or the Customer Portal. 'self' alone lets the POST finish
// and the browser drops the cross-origin redirect, so the page never changes.
const formAction = [
  "'self'",
  "https://checkout.stripe.com",
  "https://billing.stripe.com",
].join(" ");

export function contentSecurityPolicy(): string {
  const isDev = process.env.NODE_ENV === "development";
  return [
    "default-src 'self'",
    "base-uri 'self'",
    `form-action ${formAction}`,
    `script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com https://*.stripe.com${isDev ? " 'unsafe-eval'" : ""}`,
    "frame-src https://js.stripe.com https://*.js.stripe.com https://*.stripe.com https://hooks.stripe.com",
    "connect-src 'self' https://api.stripe.com https://*.stripe.com",
    "img-src 'self' data: https://*.stripe.com",
    "style-src 'self' 'unsafe-inline' https://*.stripe.com",
    "font-src 'self'",
  ].join("; ");
}
