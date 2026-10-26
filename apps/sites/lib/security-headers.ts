/**
 * Response headers for every tenant-site response (SEC-03; ADR-002). Applied to all paths by next.config.ts;
 * the host pages add their own Content-Security-Policy (lib/pages.ts), which is stricter than anything a shared
 * header could be. Framing: no one may frame a tenant site until the dashboard preview handshake exists (P3,
 * signed token; SEC-03 "only dashboard preview may frame draft mode").
 */
export const SECURITY_HEADERS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
];
