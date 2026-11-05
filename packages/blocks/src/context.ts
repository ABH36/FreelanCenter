/**
 * Everything a block may know about the site it renders in. Blocks are pure: no I/O, no globals, no hooks. The
 * renderer (apps/sites, S4) builds one context per request and injects the side-effecting pieces (asset URLs, lead
 * form endpoint, error reporting).
 */
import type { SiteConfig } from '@platform/schema';
import type { MotionPreset } from '@platform/ui';
import type { Locale } from './strings';

/** ADR-009: images are referenced through fixed pre-generated widths only. */
export const IMAGE_WIDTHS = [400, 800, 1200, 1600] as const;
export type ImageWidth = (typeof IMAGE_WIDTHS)[number];

export type RenderMode = 'public' | 'preview' | 'draft';

export interface BlockErrorInfo {
  readonly sectionId: string;
  readonly type: string;
  readonly variant: string;
  readonly stage: 'props' | 'render' | 'unknown-block';
  /** Safe summary only (no props, no tenant text). */
  readonly message: string;
}

export interface RenderContext {
  readonly business: SiteConfig['business'];
  readonly navigation: SiteConfig['navigation'];
  readonly footer: SiteConfig['footer'];
  readonly motionPreset: MotionPreset;
  readonly locale: Locale;
  /** Where the site is served under its host: empty normally, `/p/<token>` for a preview. Prefixes every in-site link. */
  readonly basePath: string;
  /** `public` renders nothing for a broken block; `preview` and `draft` show a visible placeholder. */
  readonly mode: RenderMode;
  /** Resolves an asset id to a URL on our asset domain, or `null` while the asset is not available (placeholder). */
  readonly assetUrl: (assetId: string, width: ImageWidth) => string | null;
  /** Lead capture endpoint (module 09, P5). `null` until it exists: the contact form then degrades to contact details. */
  readonly leadForm: { readonly action: string } | null;
  /** "Built with ..." badge, from platform settings. `null` hides it. */
  readonly platformBadge: { readonly label: string; readonly href: string } | null;
  readonly onBlockError?: (info: BlockErrorInfo) => void;
}

/** Context for tests and previews that have no asset domain yet. */
export function createContext(
  config: Pick<SiteConfig, 'business' | 'navigation' | 'footer' | 'theme'>,
  overrides: Partial<RenderContext> = {},
): RenderContext {
  return {
    business: config.business,
    navigation: config.navigation,
    footer: config.footer,
    motionPreset: config.theme.motion.preset,
    locale: config.business.language,
    basePath: '',
    mode: 'public',
    assetUrl: () => null,
    leadForm: null,
    platformBadge: null,
    ...overrides,
  };
}
