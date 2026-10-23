import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@platform/ui',
    '@platform/auth',
    '@platform/db',
    '@platform/logger',
    '@platform/providers',
    '@platform/jobs',
    '@platform/workspaces',
  ],
  async headers() {
    // Baseline hardening (SEC-03). A full per-surface CSP lands with the builder (P3).
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Nothing may frame the dashboard: sign-in and settings forms are clickjacking targets.
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
      {
        // SEC-11: pages and endpoints that carry a single-use token in the URL never leak it as a referrer.
        source: '/reset-password',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        source: '/api/auth/:path(reset-password|verify-email)/:rest*',
        headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
      },
      {
        // SEC-11: the invitation token is in the path.
        source: '/invite/:token*',
        headers: [
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cache-Control', value: 'no-store' },
        ],
      },
    ];
  },
};

export default config;
