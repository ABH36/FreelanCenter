/**
 * Where a rendered site's content comes from. P2 builds and tests the whole render path against this interface; the
 * implementation is published SiteVersions through `app.get_published_version` (P3 S7a, app_public only). A host without
 * a live version keeps the placeholder.
 */

export interface SiteContent {
  /** The stored SiteConfig. Untrusted: `renderDocument` validates it on every read. */
  readonly config: unknown;
  readonly lastModified?: Date;
  /** Resolves an asset id to a URL on our asset domain (ADR-009); omit until assets exist (P3). */
  readonly assetUrl?: (assetId: string, width: 400 | 800 | 1200 | 1600) => string | null;
  /** Origin of those URLs, for the CSP `img-src` (for example `https://assets.example.test`). */
  readonly assetOrigin?: string | null;
  /** Lead capture endpoint (module 09, P5). */
  readonly leadForm?: { readonly action: string } | null;
  readonly platformBadge?: { readonly label: string; readonly href: string } | null;
  /** Staging, review and similar: rendered but not indexable. */
  readonly noindex?: boolean;
}

/** A live host (P3 S7a: resolve_host outcome `live`): the tenant, project and the live version to load. */
export interface ServableResolution {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly siteVersionId: string;
}

export interface SiteSource {
  load(resolution: ServableResolution): Promise<SiteContent | null>;
}

/** No site is published (tests, or an environment without a database). */
export const emptySiteSource: SiteSource = { load: async () => null };

const WIDTHS = [400, 800, 1200, 1600] as const;
type Width = (typeof WIDTHS)[number];

/**
 * The image URLs a version snapshotted when it was published (`site_versions.assets`: asset id -> { width: URL }).
 * Untrusted like the config: only URLs on ONE origin, https (or http on localhost or 127.0.0.1 for development), are kept, and
 * that origin is what the CSP allows for images. Anything else is dropped (the image then renders without a source).
 */
export function versionAssets(raw: unknown): Pick<SiteContent, 'assetUrl' | 'assetOrigin'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const map = new Map<string, Partial<Record<Width, string>>>();
  let origin: string | null = null;
  for (const [id, widths] of Object.entries(raw as Record<string, unknown>).slice(0, 500)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !widths || typeof widths !== 'object') continue;
    const urls: Partial<Record<Width, string>> = {};
    for (const w of WIDTHS) {
      const value = (widths as Record<string, unknown>)[String(w)];
      if (typeof value !== 'string' || value.length > 2048) continue;
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        continue;
      }
      const local =
        url.protocol === 'http:' &&
        (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '127.0.0.1');
      if ((url.protocol !== 'https:' && !local) || url.username || url.password) continue;
      origin ??= url.origin;
      if (url.origin !== origin) continue;
      urls[w] = url.href;
    }
    if (Object.keys(urls).length) map.set(id, urls);
  }
  if (map.size === 0) return {};
  return {
    assetUrl: (assetId, width) => map.get(assetId)?.[width] ?? null,
    assetOrigin: origin,
  };
}

export interface PublishedVersionReader {
  (versionId: string): Promise<{ config: unknown; assets: unknown; publishedAt: Date } | null>;
}

/**
 * Published live versions through `app.get_published_version` (app_public). A version never changes, so the content
 * is kept in process by id (bounded); publishing or rolling back changes the version id the host resolves to, not
 * the cached content. A database failure throws (the route answers 503 and caches nothing).
 */
export function createVersionSiteSource(
  read: PublishedVersionReader,
  options: { maxEntries?: number } = {},
): SiteSource {
  const max = options.maxEntries ?? 30;
  const cache = new Map<string, SiteContent | null>();
  return {
    async load(resolution) {
      if (cache.has(resolution.siteVersionId)) {
        const hit = cache.get(resolution.siteVersionId) ?? null;
        // Refresh the entry's position (least recently used goes first).
        cache.delete(resolution.siteVersionId);
        cache.set(resolution.siteVersionId, hit);
        return hit;
      }
      const row = await read(resolution.siteVersionId);
      const content: SiteContent | null = row
        ? { config: row.config, lastModified: row.publishedAt, ...versionAssets(row.assets) }
        : null;
      if (cache.size >= max) cache.delete(cache.keys().next().value as string);
      if (content) cache.set(resolution.siteVersionId, content);
      return content;
    },
  };
}
