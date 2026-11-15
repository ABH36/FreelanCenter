/** Colour maths for theme compilation and WCAG 2.1 contrast checks. Input is always a validated 6-digit hex. */

const HEX = /^#[0-9a-fA-F]{6}$/;

export type Rgb = readonly [number, number, number];

export function parseHex(hex: string): Rgb {
  if (!HEX.test(hex)) throw new Error('Not a 6-digit hex colour');
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

export function toHex([r, g, b]: Rgb): string {
  const part = (n: number) =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

/** WCAG 2.1 relative luminance. */
export function luminance(hex: string): number {
  const lin = parseHex(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** WCAG 2.1 contrast ratio, 1..21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear mix in sRGB space; `amount` 0..1 moves `from` toward `to`. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from);
  const b = parseHex(to);
  return toHex(
    [0, 1, 2].map((i) => (a[i] as number) + ((b[i] as number) - (a[i] as number)) * amount) as unknown as Rgb,
  );
}

/** Text colour (black or white) that has the higher contrast on `background`. */
export function onColor(background: string): '#000000' | '#ffffff' {
  return contrastRatio(background, '#ffffff') >= contrastRatio(background, '#000000') ? '#ffffff' : '#000000';
}

export interface ContrastCheck {
  readonly pair: string;
  readonly ratio: number;
  readonly required: number;
}

export type ThemeColors = Readonly<
  Record<'primary' | 'secondary' | 'accent' | 'background' | 'surface' | 'text', string>
>;

/**
 * WCAG 2.1 AA checks on the colour tokens: 4.5:1 for text pairs, 3:1 for UI components and large text (1.4.3,
 * 1.4.11). No schema import, so the editor can run it in the browser as the person picks colours (P3 S5);
 * `contrastIssues` (theme.ts) runs the same checks on a validated theme for preflight.
 */
export function contrastChecks(
  colors: ThemeColors,
  buttonStyle: 'solid' | 'outline' | 'ghost',
): ContrastCheck[] {
  const checks: [string, string, string, number][] = [
    ['text on background', colors.text, colors.background, 4.5],
    ['text on surface', colors.text, colors.surface, 4.5],
    ['button label on button', onColor(colors.primary), colors.primary, 4.5],
    [
      'primary on background (links, outline buttons, focus ring)',
      colors.primary,
      colors.background,
      buttonStyle === 'solid' ? 3 : 4.5,
    ],
    ['primary on surface', colors.primary, colors.surface, buttonStyle === 'solid' ? 3 : 4.5],
    ['accent on background (large text and icons)', colors.accent, colors.background, 3],
  ];
  return checks
    .map(([pair, fg, bg, required]) => ({ pair, ratio: Number(contrastRatio(fg, bg).toFixed(2)), required }))
    .filter((c) => c.ratio < c.required);
}

/**
 * P3 S5 (approved 2026-11-15): ready-made colour sets for the theme editor. Every one passes `contrastChecks` with
 * every button style (palettes.test.ts), so picking one never creates a contrast problem.
 */
export const THEME_PALETTES: ReadonlyArray<{ readonly name: string; readonly colors: ThemeColors }> = [
  {
    name: 'Deep blue',
    colors: {
      primary: '#1D4ED8',
      secondary: '#0F172A',
      accent: '#B45309',
      background: '#FFFFFF',
      surface: '#F1F5F9',
      text: '#0F172A',
    },
  },
  {
    name: 'Warm saffron',
    colors: {
      primary: '#C2410C',
      secondary: '#431407',
      accent: '#A16207',
      background: '#FFFBF5',
      surface: '#FFF1E0',
      text: '#1C1917',
    },
  },
  {
    name: 'Forest green',
    colors: {
      primary: '#15803D',
      secondary: '#052E16',
      accent: '#0369A1',
      background: '#FFFFFF',
      surface: '#F0FDF4',
      text: '#14532D',
    },
  },
  {
    name: 'Royal maroon',
    colors: {
      primary: '#9F1239',
      secondary: '#4C0519',
      accent: '#B45309',
      background: '#FFF7F7',
      surface: '#FDECEC',
      text: '#1F1315',
    },
  },
  {
    name: 'Midnight',
    colors: {
      primary: '#F97316',
      secondary: '#E4E4E7',
      accent: '#FACC15',
      background: '#0B0B0F',
      surface: '#18181B',
      text: '#F9FAFB',
    },
  },
  {
    name: 'Clinic teal',
    colors: {
      primary: '#0F766E',
      secondary: '#134E4A',
      accent: '#6D28D9',
      background: '#FFFFFF',
      surface: '#F0FDFA',
      text: '#134E4A',
    },
  },
];
