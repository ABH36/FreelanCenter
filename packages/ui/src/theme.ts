/**
 * Theme compiler (FR-TPL-04): SiteConfig `theme` tokens -> CSS custom properties. There is no per-site stylesheet
 * build: the same static CSS (Tailwind, motion, block styles) serves every tenant and only this small variable block
 * differs. Every emitted value comes from a lookup table or a validated 6-digit hex; free text never reaches CSS.
 */
import { SECTION_PADDING, themeSchema, type Theme } from '@platform/schema';
import { contrastRatio, luminance, mix, onColor } from './color';
import { fontStack } from './fonts';
import { motionVariables } from './motion';

export const DEFAULT_THEME: Theme = {
  colors: {
    primary: '#1D4ED8',
    secondary: '#111827',
    accent: '#B45309',
    background: '#FFFFFF',
    surface: '#F3F4F6',
    text: '#111827',
  },
  typography: { heading: 'Inter', body: 'Inter', scale: 'comfortable' },
  radius: 'md',
  spacing: 'regular',
  buttons: { style: 'solid', shape: 'rounded', hover: 'darken' },
  motion: { preset: 'subtle', reducedMotionRespected: true },
};

const RADIUS = {
  none: ['0px', '0px', '0px'],
  sm: ['0.125rem', '0.25rem', '0.375rem'],
  md: ['0.25rem', '0.5rem', '0.75rem'],
  lg: ['0.5rem', '0.75rem', '1.25rem'],
  xl: ['0.75rem', '1.25rem', '2rem'],
  full: ['0.5rem', '1.5rem', '2.5rem'],
} as const;

const SCALE = {
  compact: { base: 15, ratio: 1.2 },
  comfortable: { base: 16, ratio: 1.25 },
  spacious: { base: 17, ratio: 1.333 },
} as const;

/** Section vertical padding at spacing "regular", in rem; compact and relaxed multiply it. */
const PADDING_REM: Record<(typeof SECTION_PADDING)[number], number> = {
  none: 0,
  sm: 2,
  md: 3.5,
  lg: 5,
  xl: 7,
};
const SPACING_FACTOR = { compact: 0.7, regular: 1, relaxed: 1.35 } as const;

const rem = (n: number) => `${Number(n.toFixed(3))}rem`;

function typeVariables(scale: Theme['typography']['scale']): string[] {
  const { base, ratio } = SCALE[scale];
  const step = (n: number) => rem(ratio ** n);
  return [
    `--font-size-root:${base}px`,
    `--text-sm:${rem(1 / ratio)}`,
    '--text-base:1rem',
    `--text-lg:${step(1)}`,
    `--text-xl:${step(2)}`,
    `--text-2xl:${step(3)}`,
    `--text-3xl:${step(4)}`,
    `--text-4xl:${step(5)}`,
  ];
}

function buttonVariables(t: Theme, onPrimary: string): string[] {
  const { colors, buttons, radius } = t;
  const base = RADIUS[radius][1];
  const shape = { square: '0px', rounded: base, pill: '9999px' }[buttons.shape];
  const solid = buttons.style === 'solid';
  const hoverBg = solid ? mix(colors.primary, '#000000', 0.15) : mix(colors.primary, colors.background, 0.9);
  const hover = {
    none: { transform: 'none', shadow: 'none' },
    lift: { transform: 'translateY(-2px)', shadow: `0 6px 14px ${mix(colors.text, colors.background, 0.8)}` },
    glow: { transform: 'none', shadow: `0 0 0 4px ${mix(colors.primary, colors.background, 0.65)}` },
    darken: { transform: 'none', shadow: 'none' },
  }[buttons.hover];
  return [
    `--btn-radius:${shape}`,
    `--btn-bg:${solid ? colors.primary : 'transparent'}`,
    `--btn-fg:${solid ? onPrimary : colors.primary}`,
    `--btn-border:${buttons.style === 'ghost' ? 'transparent' : colors.primary}`,
    // "none" keeps the base look on hover; the other three change something that is visible without colour alone.
    `--btn-hover-bg:${buttons.hover === 'none' ? (solid ? colors.primary : 'transparent') : hoverBg}`,
    `--btn-hover-transform:${hover.transform}`,
    `--btn-hover-shadow:${hover.shadow}`,
  ];
}

/** Text-link colour: the brand primary when it reads on both page surfaces (WCAG AA 4.5:1), else the nearest blend toward the text colour that does. */
export function linkColor(c: Theme['colors']): string {
  const ok = (hex: string) => contrastRatio(hex, c.background) >= 4.5 && contrastRatio(hex, c.surface) >= 4.5;
  if (ok(c.primary)) return c.primary.toLowerCase();
  for (let i = 1; i <= 20; i += 1) {
    const candidate = mix(c.primary, c.text, i / 20);
    if (ok(candidate)) return candidate;
  }
  return c.text.toLowerCase();
}

/**
 * Secondary text colour: 65 % text over the background by default (the look), moved toward the text colour until it
 * reads at 4.5:1 on both the background and the surface. Guaranteed by construction, like `linkColor`.
 */
export function mutedColor(c: Theme['colors']): string {
  const ok = (hex: string) => contrastRatio(hex, c.background) >= 4.5 && contrastRatio(hex, c.surface) >= 4.5;
  for (let amount = 0.35; amount >= 0; amount -= 0.05) {
    const candidate = mix(c.text, c.background, Math.max(amount, 0));
    if (ok(candidate)) return candidate;
  }
  return c.text.toLowerCase();
}

/** Theme variables as `--name:value` declarations. Throws if the theme does not validate. */
export function themeDeclarations(input: Theme): string[] {
  const theme = themeSchema.parse(input);
  const { colors } = theme;
  const [rSm, rBase, rLg] = RADIUS[theme.radius];
  const factor = SPACING_FACTOR[theme.spacing];
  const onPrimary = onColor(colors.primary);
  return [
    ...(['primary', 'secondary', 'accent', 'background', 'surface', 'text'] as const).map(
      (k) => `--color-${k}:${colors[k].toLowerCase()}`,
    ),
    `--color-link:${linkColor(colors)}`,
    `--color-on-primary:${onPrimary}`,
    `--color-on-secondary:${onColor(colors.secondary)}`,
    `--color-on-accent:${onColor(colors.accent)}`,
    `--color-border:${mix(colors.text, colors.background, 0.85)}`,
    `--color-muted:${mutedColor(colors)}`,
    // Bands restyle --color-muted for their own text; cards and full-bleed heroes on a band restore this one.
    `--color-muted-base:${mutedColor(colors)}`,
    `color-scheme:${luminance(colors.background) < 0.35 ? 'dark' : 'light'}`,
    `--font-heading:${fontStack(theme.typography.heading)}`,
    `--font-body:${fontStack(theme.typography.body)}`,
    `--radius-sm:${rSm}`,
    `--radius-base:${rBase}`,
    `--radius-lg:${rLg}`,
    ...SECTION_PADDING.map((k) => `--section-py-${k}:${rem(PADDING_REM[k] * factor)}`),
    ...typeVariables(theme.typography.scale),
    ...buttonVariables(theme, onPrimary),
    ...motionVariables(theme.motion.preset).split(';').filter(Boolean),
  ];
}

export type ThemeScope = ':root' | '[data-theme-scope]';

/** The `:root{...}` block for a validated theme. */
export function compileThemeCss(theme: Theme, scope: ThemeScope = ':root'): string {
  return `${scope}{${themeDeclarations(theme).join(';')}}`;
}

/**
 * Renderer entry point: never throws. An invalid theme (a stored config that no longer validates) degrades to the
 * platform default instead of breaking the page.
 */
export function compileThemeCssSafe(
  theme: unknown,
  scope: ThemeScope = ':root',
): { css: string; fallback: boolean } {
  const parsed = themeSchema.safeParse(theme);
  return parsed.success
    ? { css: compileThemeCss(parsed.data, scope), fallback: false }
    : { css: compileThemeCss(DEFAULT_THEME, scope), fallback: true };
}

export interface ContrastIssue {
  readonly pair: string;
  readonly ratio: number;
  readonly required: number;
  readonly level: 'error';
}

/**
 * WCAG 2.1 AA checks on the colour tokens (SRS 5.2 "contrast is checked in preflight"; the builder and preflight
 * engine call this in P3, reference templates must pass it in S5).
 * 4.5:1 for text pairs, 3:1 for UI-component and large-text pairs (1.4.3, 1.4.11).
 */
export function contrastIssues(theme: Theme): ContrastIssue[] {
  const t = themeSchema.parse(theme);
  const { colors, buttons } = t;
  const checks: [string, string, string, number][] = [
    ['text on background', colors.text, colors.background, 4.5],
    ['text on surface', colors.text, colors.surface, 4.5],
    ['button label on button', onColor(colors.primary), colors.primary, 4.5],
    [
      'primary on background (links, outline buttons, focus ring)',
      colors.primary,
      colors.background,
      buttons.style === 'solid' ? 3 : 4.5,
    ],
    ['primary on surface', colors.primary, colors.surface, buttons.style === 'solid' ? 3 : 4.5],
    ['accent on background (large text and icons)', colors.accent, colors.background, 3],
  ];
  return checks
    .map(([pair, fg, bg, required]) => ({ pair, ratio: Number(contrastRatio(fg, bg).toFixed(2)), required }))
    .filter((c) => c.ratio < c.required)
    .map((c) => ({ ...c, level: 'error' as const }));
}
