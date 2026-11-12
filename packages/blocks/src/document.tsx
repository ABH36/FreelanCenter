/**
 * `renderDocument`: SiteConfig + request path -> a complete HTML document (FR-TPL-03, SRS 5.2 "renderer").
 *
 * No client JavaScript is emitted: the page is HTML plus two inline stylesheets (a static one shared by every
 * tenant, and a small per-site one with the theme variables and font faces), which is what lets the host apply a
 * strict hash-based CSP. Every dynamic value in the head is escaped for its context; the body is React output.
 * The caller supplies everything with side effects (asset URLs, lead endpoint, error reporting) and turns the result
 * into an HTTP response; this module does no I/O.
 */
import { Fragment, type ReactNode } from 'react';
import { parseSiteConfig, type ConfigIssue, type SiteConfig } from '@platform/schema';
import { compileThemeCss, motionCss, onColor, themeFontFaceCss, themePreloads } from '@platform/ui';
import { Footer, FloatingActions, Header } from './chrome';
import { createContext, type BlockErrorInfo, type RenderContext, type RenderMode } from './context';
import { BLOCKS_CSS } from './css-bundle';
import { renderSections } from './render';
import { serialize } from './serialize';
import type { BlockRegistry } from './registry';
import { escapeHtml, localBusinessJsonLd, pageUrl, safeJsonForScript } from './seo';
import { t } from './strings';

const PAGE_CSS =
  'body{margin:0;background:var(--color-background)}html{-webkit-text-size-adjust:100%}' +
  '@media (prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}';

/** The stylesheet shared by every tenant site. The host hashes it once for the CSP. */
export const STATIC_CSS = `${BLOCKS_CSS}${motionCss()}${PAGE_CSS}`;

export interface DocumentInput {
  /** The stored config, untrusted: it is validated here. */
  readonly config: unknown;
  /** Request path without query, e.g. `/` or `/about`. */
  readonly path: string;
  /** Scheme and host of the site, no trailing slash. Used for canonical, Open Graph and structured data. */
  readonly origin: string;
  readonly mode: RenderMode;
  readonly assetUrl?: RenderContext['assetUrl'];
  readonly leadForm?: RenderContext['leadForm'];
  readonly platformBadge?: RenderContext['platformBadge'];
  readonly onBlockError?: (info: BlockErrorInfo) => void;
  readonly registry?: BlockRegistry;
  /** Force `noindex` (staging, suspended, review). Non-public modes are always noindex. */
  readonly noindex?: boolean;
  readonly fontBase?: string;
  /**
   * Where the site is served under its host, for example `/p/<token>` for a preview. Every in-site link is prefixed
   * with it; `path` is still the path inside the site.
   */
  readonly basePath?: string;
  /** A notice above the header (previews: "demo content, not a live website"). Plain text, escaped on output. */
  readonly banner?: string;
}

export type DocumentResult =
  | {
      readonly kind: 'page';
      readonly status: 200 | 404;
      readonly html: string;
      /** Exact text of each inline `<style>`, for the CSP hashes. */
      readonly inlineStyles: readonly string[];
      readonly indexable: boolean;
    }
  | { readonly kind: 'invalid'; readonly issues: readonly ConfigIssue[] }
  | { readonly kind: 'error' };

const ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
// A preview link (`/p/<token>`) is the longest base path: tokens are at most 700 characters (PREVIEW_TOKEN.maxLength).
const BASE_PATH = /^(\/[A-Za-z0-9._~-]{1,700}){1,3}$/;

/** Limit by characters (not bytes), never splitting a surrogate pair. */
export function clip(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max
    ? value
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * Preload for the first (LCP) image: the body already carries the escaped `srcset`/`sizes` of the one image marked
 * `fetchpriority="high"`, so they are copied verbatim into a responsive preload hint.
 */
function lcpImagePreload(bodyHtml: string): string {
  const tag = /<img\b[^>]*\sfetchpriority="high"[^>]*>/.exec(bodyHtml)?.[0];
  const srcset = tag ? /\ssrcset="([^"]*)"/.exec(tag)?.[1] : undefined;
  const sizes = tag ? /\ssizes="([^"]*)"/.exec(tag)?.[1] : undefined;
  return srcset && sizes
    ? `<link rel="preload" as="image" imagesrcset="${srcset}" imagesizes="${sizes}" fetchpriority="high">`
    : '';
}

function faviconHref(config: SiteConfig): string {
  const initial = Array.from(config.business.name).find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '•';
  const { primary } = config.theme.colors;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${primary}"/>` +
    `<text x="32" y="45" font-size="38" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="${onColor(primary)}">${escapeHtml(initial)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const meta = (name: string, content: string) => `<meta name="${name}" content="${escapeHtml(content)}">`;
const og = (property: string, content: string) =>
  `<meta property="${property}" content="${escapeHtml(content)}">`;

function shell(input: { config: SiteConfig; lang: string; head: string; body: string; themeStyle: string }): {
  html: string;
  inlineStyles: string[];
} {
  const inlineStyles = [STATIC_CSS, input.themeStyle];
  const html =
    `<!doctype html><html lang="${input.lang}"><head><meta charset="utf-8">` +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    `${input.head}<style>${STATIC_CSS}</style><style>${input.themeStyle}</style></head><body>${input.body}</body></html>`;
  return { html, inlineStyles };
}

function page(
  ctx: RenderContext,
  currentPath: string,
  mainChildren: ReactNode,
  banner: string | undefined,
): string {
  return serialize(
    <div className="pb-root">
      {banner ? (
        <div className="pb-banner" role="note">
          {banner}
        </div>
      ) : null}
      <Header ctx={ctx} currentPath={currentPath} />
      <main id="main">{mainChildren}</main>
      <Footer ctx={ctx} />
      <FloatingActions ctx={ctx} />
    </div>,
  );
}

export function renderDocument(input: DocumentInput): DocumentResult {
  try {
    if (!ORIGIN.test(input.origin)) return { kind: 'error' };
    if (input.basePath !== undefined && !BASE_PATH.test(input.basePath)) return { kind: 'error' };
    const parsed = parseSiteConfig(input.config);
    if (!parsed.ok) return { kind: 'invalid', issues: parsed.issues };
    const config = parsed.config;

    const path = input.path.length > 1 && input.path.endsWith('/') ? input.path.slice(0, -1) : input.path;
    const found = config.pages.find((p) => p.path === path);
    const ctx = createContext(config, {
      mode: input.mode,
      basePath: input.basePath ?? '',
      ...(input.assetUrl ? { assetUrl: input.assetUrl } : {}),
      ...(input.leadForm !== undefined ? { leadForm: input.leadForm } : {}),
      ...(input.platformBadge !== undefined ? { platformBadge: input.platformBadge } : {}),
      ...(input.onBlockError ? { onBlockError: input.onBlockError } : {}),
    });
    const { business, theme } = config;
    const lang = business.language;
    const themeStyle = `${compileThemeCss(theme)}${themeFontFaceCss(theme, input.fontBase ?? '/fonts')}`;
    const preloads = themePreloads(theme, input.fontBase ?? '/fonts')
      .map(
        (href) => `<link rel="preload" as="font" type="font/woff2" href="${escapeHtml(href)}" crossorigin>`,
      )
      .join('');
    const publicMode = input.mode === 'public' && input.noindex !== true;

    if (!found) {
      const body = page(
        ctx,
        path,
        <section className="pb-section pb-py-xl">
          <div className="pb-container pb-narrow">
            <h1 className="pb-h1">{t(lang, 'notFoundTitle')}</h1>
            <p className="pb-lead">{t(lang, 'notFoundText')}</p>
            <a className="pb-btn pb-btn--primary" href={ctx.basePath || '/'}>
              {t(lang, 'backHome')}
            </a>
          </div>
        </section>,
        input.banner,
      );
      const head =
        `<title>${escapeHtml(`${t(lang, 'notFoundTitle')} | ${clip(business.name, 50)}`)}</title>` +
        meta('robots', 'noindex,nofollow') +
        `<link rel="icon" href="${escapeHtml(faviconHref(config))}">${preloads}`;
      const out = shell({ config, lang, head, body, themeStyle });
      return { kind: 'page', status: 404, html: out.html, inlineStyles: out.inlineStyles, indexable: false };
    }

    const indexable = publicMode && found.seo?.noindex !== true;
    const { nodes, h1Used } = renderSections(
      found.sections,
      ctx,
      input.registry ? { registry: input.registry } : {},
    );
    const body = page(
      ctx,
      path,
      <>
        {h1Used ? null : <h1 className="pb-sr-only">{found.title}</h1>}
        {nodes.map((n) => (
          <Fragment key={n.id}>{n.node}</Fragment>
        ))}
      </>,
      input.banner,
    );

    const isHome = found.path === '/';
    const title = clip(
      found.seo?.title ||
        (isHome
          ? business.tagline
            ? `${business.name} - ${business.tagline}`
            : business.name
          : `${found.title} | ${business.name}`),
      70,
    );
    const description = found.seo?.description || (business.tagline ? clip(business.tagline, 160) : '');
    const canonical = pageUrl(input.origin, found.path);
    const ogImageId = found.seo?.ogImage ?? null;
    const assetUrl = ctx.assetUrl;
    const ogImage = ogImageId ? assetUrl(ogImageId.assetId, 1200) : null;
    const logoUrl = business.logo ? assetUrl(business.logo.assetId, 400) : null;

    const headParts = [
      `<title>${escapeHtml(title)}</title>`,
      description ? meta('description', description) : '',
      meta('robots', indexable ? 'index,follow,max-image-preview:large' : 'noindex,nofollow'),
      publicMode ? `<link rel="canonical" href="${escapeHtml(canonical)}">` : '',
      meta('theme-color', theme.colors.background),
      og('og:type', 'website'),
      og('og:site_name', business.name),
      og('og:title', title),
      description ? og('og:description', description) : '',
      publicMode ? og('og:url', canonical) : '',
      og('og:locale', lang === 'hi' ? 'hi_IN' : 'en_IN'),
      ogImage && ogImageId ? og('og:image', ogImage) + og('og:image:alt', ogImageId.alt) : '',
      meta('twitter:card', ogImage ? 'summary_large_image' : 'summary'),
      `<link rel="icon" href="${escapeHtml(faviconHref(config))}">`,
      preloads,
      lcpImagePreload(body),
      isHome && publicMode
        ? `<script type="application/ld+json">${safeJsonForScript(localBusinessJsonLd(config, input.origin, ogImage, logoUrl))}</script>`
        : '',
    ];
    const out = shell({ config, lang, head: headParts.join(''), body, themeStyle });
    return { kind: 'page', status: 200, html: out.html, inlineStyles: out.inlineStyles, indexable };
  } catch {
    // The caller serves the platform "unavailable" page; nothing about the config is leaked.
    return { kind: 'error' };
  }
}
