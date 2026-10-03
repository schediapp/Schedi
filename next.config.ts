import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.js.stripe.com https://*.stripe.com${isDev ? " 'unsafe-eval'" : ""}`,
  "frame-src https://js.stripe.com https://*.js.stripe.com https://*.stripe.com https://hooks.stripe.com",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com",
  "img-src 'self' data: https://*.stripe.com",
  "style-src 'self' 'unsafe-inline' https://*.stripe.com",
  "font-src 'self'",
].join("; ");

const nextConfig: NextConfig = {
  serverExternalPackages: ["stripe"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
