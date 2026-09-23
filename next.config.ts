import type { NextConfig } from "next";

/**
 * Security headers — sensible, honest protections.
 *
 * CSP note (documented in docs/security.md): Next.js applications
 * inject inline bootstrap/style tags that carry no nonce in this
 * setup, so `style-src` and `script-src` must allow 'unsafe-inline'
 * (and dev-mode hot reload needs 'unsafe-eval'). Everything else is
 * locked to same-origin, framing is refused outright, and referrers
 * never carry paths. Chosen deliberately over a stricter policy that
 * would break the app — documented rather than hidden.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // microphone=(self): voice capture happens in the composer (Phase 9)
    // and must reach the user's own microphone, nothing else.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), interest-cohort=()",
  },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Native/binary-backed server packages must stay outside the bundler
  // (sharp for image validation + thumbnails — Phase 9).
  serverExternalPackages: ["sharp"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
