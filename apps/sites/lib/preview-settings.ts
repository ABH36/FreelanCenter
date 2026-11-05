import { normalizeHost } from '@platform/hosting';

/**
 * Preview links are on only when both `PREVIEW_HOST` (a name under the sites domain, for example
 * `preview.sites.example.com`) and `PREVIEW_TOKEN_SECRET` (32 or more characters, shared with the dashboard that mints
 * the links) are set. `PREVIEW_TOKEN_SECRET_PREVIOUS` keeps links minted with the old secret valid while a new one rolls
 * out. Anything else leaves the preview host an ordinary unknown host.
 */
export function previewSettings(
  env: Record<string, string | undefined> = process.env,
): { host: string; secrets: { current: string; previous?: string } } | null {
  const host = normalizeHost(env.PREVIEW_HOST);
  const current = env.PREVIEW_TOKEN_SECRET;
  if (!host || !current || current.length < 32) return null;
  const previous = env.PREVIEW_TOKEN_SECRET_PREVIOUS;
  return { host, secrets: { current, ...(previous && previous.length >= 32 ? { previous } : {}) } };
}
