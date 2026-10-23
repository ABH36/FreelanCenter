/**
 * Runtime configuration for product auth, read once from the environment and validated up front so a
 * misconfigured deployment fails at start-up instead of silently running with unsafe defaults (ADR-006).
 */

export type EmailTransport = 'resend' | 'capture';

export interface AuthConfig {
  /** Public origin of the dashboard, e.g. `https://app.example.com` (BETTER_AUTH_URL). */
  baseURL: string;
  /** >= 32 characters; signs cookies and encrypts TOTP secrets and OAuth tokens. */
  secret: string;
  appName: string;
  /**
   * The one request header that carries the real client IP (Spike F F-5). On Vercel this is
   * `x-vercel-forwarded-for`, which the edge overwrites; a header the client can set evades the rate limit.
   */
  clientIpHeader: string;
  /** Cloudflare Turnstile secret (SEC-09). Development and CI use Cloudflare's official test keys. */
  turnstileSecretKey: string;
  google: { clientId: string; clientSecret: string } | null;
  email: { transport: 'capture' } | { transport: 'resend'; apiKey: string; from: string };
}

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/** Cloudflare's documented test keys (https://developers.cloudflare.com/turnstile/troubleshooting/testing/). */
export const TURNSTILE_TEST_KEYS = {
  siteKeyPass: '1x00000000000000000000AA',
  secretPass: '1x0000000000000000000000000000000AA',
  secretFail: '2x0000000000000000000000000000000AA',
  /** The only response token the test secrets accept. */
  dummyToken: 'XXXX.DUMMY.TOKEN.XXXX',
} as const;

const DEFAULT_IP_HEADER_VERCEL = 'x-vercel-forwarded-for';
const DEFAULT_IP_HEADER_LOCAL = 'x-forwarded-for';

export function loadAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const production = env.NODE_ENV === 'production' && env.VERCEL_ENV === 'production';
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new AuthConfigError(`${key} is not set`);
    return value;
  };

  const baseURL = required('BETTER_AUTH_URL').replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new AuthConfigError('BETTER_AUTH_URL is not a valid URL');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new AuthConfigError('BETTER_AUTH_URL must be an origin without a path');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new AuthConfigError('BETTER_AUTH_URL must use https outside localhost');
  }

  const secret = required('BETTER_AUTH_SECRET');
  if (secret.length < 32) throw new AuthConfigError('BETTER_AUTH_SECRET must be at least 32 characters');

  const clientIpHeader = (
    env.AUTH_CLIENT_IP_HEADER?.trim() || (env.VERCEL ? DEFAULT_IP_HEADER_VERCEL : DEFAULT_IP_HEADER_LOCAL)
  ).toLowerCase();

  const turnstileSecretKey = required('TURNSTILE_SECRET_KEY');
  if (production && turnstileSecretKey.startsWith('1x0000')) {
    throw new AuthConfigError('the Turnstile test secret must not be used in production');
  }

  const googleId = env.GOOGLE_CLIENT_ID?.trim();
  const googleSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (Boolean(googleId) !== Boolean(googleSecret)) {
    throw new AuthConfigError('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
  }

  const transport = (env.EMAIL_TRANSPORT?.trim() || (production ? 'resend' : 'capture')) as string;
  let email: AuthConfig['email'];
  if (transport === 'resend') {
    email = { transport, apiKey: required('EMAIL_PROVIDER_API_KEY'), from: required('EMAIL_FROM') };
  } else if (transport === 'capture') {
    if (production) throw new AuthConfigError('EMAIL_TRANSPORT=capture is not allowed in production');
    email = { transport };
  } else {
    throw new AuthConfigError('EMAIL_TRANSPORT must be resend or capture');
  }

  return {
    baseURL,
    secret,
    appName: env.APP_NAME?.trim() || 'Platform',
    clientIpHeader,
    turnstileSecretKey,
    google: googleId && googleSecret ? { clientId: googleId, clientSecret: googleSecret } : null,
    email,
  };
}
