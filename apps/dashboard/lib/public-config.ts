import 'server-only';
import { connection } from 'next/server';

/**
 * Values the server hands to client components as props (no NEXT_PUBLIC_ build-time inlining). Read at request
 * time, so one build serves every environment.
 */
export async function publicAuthConfig() {
  await connection();
  const siteKey = process.env.TURNSTILE_SITE_KEY?.trim();
  if (!siteKey) throw new Error('TURNSTILE_SITE_KEY is not set');
  return {
    turnstileSiteKey: siteKey,
    googleEnabled: Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()),
  };
}
