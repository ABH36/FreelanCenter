/**
 * Where a rendered site's content comes from. P2 builds and tests the whole render path against this interface; the
 * implementations arrive later: published SiteVersions through `app.get_published_version` (P3, app_public only) and
 * template versions for the preview route (P2 S6). Until a source returns a site, a live host keeps the placeholder.
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

/** A live host: the tenant and project to load. */
export interface ServableResolution {
  readonly workspaceId: string;
  readonly projectId: string;
}

export interface SiteSource {
  load(resolution: ServableResolution): Promise<SiteContent | null>;
}

/** No site is published yet (everything before P3). */
export const emptySiteSource: SiteSource = { load: async () => null };
