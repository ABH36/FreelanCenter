import type { NextConfig } from 'next';
import { SECURITY_HEADERS } from './lib/security-headers';

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@platform/ui'],
  async headers() {
    // SEC-03 baseline on every path; the host pages add a strict per-response CSP (lib/pages.ts).
    return [{ source: '/:path*', headers: [...SECURITY_HEADERS] }];
  },
};

export default config;
