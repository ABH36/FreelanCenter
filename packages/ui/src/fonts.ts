/**
 * Font policy (SRS 5.2, Q19, ADR-009 stance): fonts come only from the schema allow-list, are self-hosted from our
 * own origin (`@fontsource` woff2 copied into `apps/sites/public/fonts`), and never call a third party at runtime.
 *
 * Performance policy, measured in `apps/sites/lib/fonts.test.ts`:
 * - two weights only (400 body, 700 heading/bold) keeps every pair small;
 * - `font-display: swap` so text is never invisible;
 * - the Latin subset is preloaded; the Devanagari subset is declared behind its `unicode-range`, so a page with no
 *   Devanagari characters never downloads it (the heaviest Devanagari file is about 105 KB, the lightest about 39 KB);
 * - only the two fonts a site actually uses are declared and preloaded.
 */
import { FONTS, type FontName, type Theme } from '@platform/schema';

export const FONT_WEIGHTS = [400, 700] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];
export type FontSubset = 'latin' | 'devanagari';

const UNICODE_RANGE: Record<FontSubset, string> = {
  latin:
    'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  devanagari:
    'U+0900-097F,U+1CD0-1CF9,U+200C-200D,U+20A8,U+20B9,U+20F0,U+25CC,U+A830-A839,U+A8E0-A8FF,U+11B00-11B09',
};

interface FontMeta {
  readonly slug: string;
  readonly generic: 'sans-serif' | 'serif';
}

const META: Record<FontName, FontMeta> = {
  Inter: { slug: 'inter', generic: 'sans-serif' },
  Poppins: { slug: 'poppins', generic: 'sans-serif' },
  Montserrat: { slug: 'montserrat', generic: 'sans-serif' },
  Lato: { slug: 'lato', generic: 'sans-serif' },
  Roboto: { slug: 'roboto', generic: 'sans-serif' },
  'Open Sans': { slug: 'open-sans', generic: 'sans-serif' },
  'Playfair Display': { slug: 'playfair-display', generic: 'serif' },
  Hind: { slug: 'hind', generic: 'sans-serif' },
  Mukta: { slug: 'mukta', generic: 'sans-serif' },
  'Noto Sans Devanagari': { slug: 'noto-sans-devanagari', generic: 'sans-serif' },
};

export const FONT_SLUGS = FONTS.map((f) => META[f.name].slug);

export function subsetsOf(name: FontName): readonly FontSubset[] {
  const font = FONTS.find((f) => f.name === name);
  return font?.devanagari ? ['latin', 'devanagari'] : ['latin'];
}

export function fontFileName(name: FontName, subset: FontSubset, weight: FontWeight): string {
  return `${META[name].slug}-${subset}-${weight}-normal.woff2`;
}

/** Every file a font needs, for the copy script and the budget test. */
export function fontFiles(name: FontName): string[] {
  return subsetsOf(name).flatMap((s) => FONT_WEIGHTS.map((w) => fontFileName(name, s, w)));
}

/** `"Poppins", "Noto Sans Devanagari", system-ui, sans-serif`-style stack; names come from the allow-list only. */
export function fontStack(name: FontName): string {
  const m = META[name];
  // A system Devanagari face follows for fonts without Devanagari glyphs so Hindi text never falls to tofu.
  const devanagariFallback = subsetsOf(name).includes('devanagari')
    ? []
    : ['"Noto Sans Devanagari"', '"Nirmala UI"'];
  return [`"${name}"`, ...devanagariFallback, 'system-ui', '-apple-system', '"Segoe UI"', m.generic].join(
    ', ',
  );
}

const FONT_BASE = /^\/[a-z0-9][a-z0-9/_-]{0,60}$/;

export function fontFaceCss(name: FontName, base = '/fonts'): string {
  if (!FONT_BASE.test(base)) throw new Error('Invalid font base path');
  const faces: string[] = [];
  for (const subset of subsetsOf(name)) {
    for (const weight of FONT_WEIGHTS) {
      faces.push(
        `@font-face{font-family:"${name}";font-style:normal;font-weight:${weight};font-display:swap;` +
          `src:url(${base}/${fontFileName(name, subset, weight)}) format("woff2");unicode-range:${UNICODE_RANGE[subset]}}`,
      );
    }
  }
  return faces.join('\n');
}

/** The fonts a theme uses, heading first, without duplicates. */
export function themeFonts(theme: Pick<Theme, 'typography'>): FontName[] {
  return [...new Set<FontName>([theme.typography.heading, theme.typography.body])];
}

export function themeFontFaceCss(theme: Pick<Theme, 'typography'>, base = '/fonts'): string {
  return themeFonts(theme)
    .map((f) => fontFaceCss(f, base))
    .join('\n');
}

/** Files worth a `<link rel="preload">`: Latin only, body regular and heading bold. */
export function themePreloads(theme: Pick<Theme, 'typography'>, base = '/fonts'): string[] {
  if (!FONT_BASE.test(base)) throw new Error('Invalid font base path');
  const files = new Set<string>([
    fontFileName(theme.typography.body, 'latin', 400),
    fontFileName(theme.typography.heading, 'latin', 700),
  ]);
  return [...files].map((f) => `${base}/${f}`);
}
