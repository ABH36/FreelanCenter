import { COLOR_TOKENS, FONTS, siteConfigSchema, themeSchema, type Theme } from '@platform/schema';
import { describe, expect, it } from 'vitest';
import { contrastRatio, luminance, mix, onColor, parseHex } from './color';
import {
  DEFAULT_THEME,
  compileThemeCss,
  compileThemeCssSafe,
  contrastIssues,
  themeDeclarations,
} from './theme';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomTheme(rand: () => number): Theme {
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rand() * a.length)] as T;
  const hex = () =>
    `#${Math.floor(rand() * 0xffffff)
      .toString(16)
      .padStart(6, '0')}`;
  return {
    colors: Object.fromEntries(COLOR_TOKENS.map((k) => [k, hex()])) as Theme['colors'],
    typography: {
      heading: pick(FONTS).name,
      body: pick(FONTS).name,
      scale: pick(['compact', 'comfortable', 'spacious'] as const),
    },
    radius: pick(['none', 'sm', 'md', 'lg', 'xl', 'full'] as const),
    spacing: pick(['compact', 'regular', 'relaxed'] as const),
    buttons: {
      style: pick(['solid', 'outline', 'ghost'] as const),
      shape: pick(['square', 'rounded', 'pill'] as const),
      hover: pick(['none', 'lift', 'glow', 'darken'] as const),
    },
    motion: { preset: pick(['none', 'subtle', 'energetic'] as const), reducedMotionRespected: true },
  };
}

describe('colour maths (WCAG 2.1)', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('#767676', '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(luminance('#ff0000')).toBeCloseTo(0.2126, 4);
  });
  it('mixes, parses and picks readable text', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(parseHex('#0A7F3F')).toEqual([10, 127, 63]);
    expect(onColor('#000000')).toBe('#ffffff');
    expect(onColor('#ffffff')).toBe('#000000');
    for (const bad of ['red', '#fff', '#12345g', 'url(x)', '']) expect(() => parseHex(bad)).toThrow();
  });
  it('onColor always meets 3:1 and meets 4.5:1 outside the mid-tone band', () => {
    const rand = rng(11);
    for (let i = 0; i < 500; i++) {
      const bg = `#${Math.floor(rand() * 0xffffff)
        .toString(16)
        .padStart(6, '0')}`;
      expect(contrastRatio(onColor(bg), bg)).toBeGreaterThanOrEqual(4.5 - 1e-9);
    }
  });
});

describe('theme compiler', () => {
  it('compiles the default theme deterministically', () => {
    const a = compileThemeCss(DEFAULT_THEME);
    expect(a).toBe(compileThemeCss(structuredClone(DEFAULT_THEME)));
    expect(a.startsWith(':root{')).toBe(true);
    for (const v of [
      '--color-primary:#1d4ed8',
      '--color-on-primary:#ffffff',
      '--font-heading:"Inter"',
      '--radius-base:0.5rem',
      '--section-py-xl:7rem',
      '--text-lg:1.25rem',
      '--btn-radius:0.5rem',
      '--motion-duration:450ms',
    ]) {
      expect(a).toContain(v);
    }
  });
  it('the default theme is itself a valid config theme and meets WCAG AA', () => {
    expect(themeSchema.safeParse(DEFAULT_THEME).success).toBe(true);
    expect(contrastIssues(DEFAULT_THEME)).toEqual([]);
    const { colors } = DEFAULT_THEME;
    expect(Object.keys(colors)).toEqual([...COLOR_TOKENS]);
    expect(siteConfigSchema.shape.theme).toBe(themeSchema);
  });
  it('changing a token changes only the matching variables', () => {
    const base = themeDeclarations(DEFAULT_THEME);
    const next = themeDeclarations({ ...DEFAULT_THEME, radius: 'full' });
    const changed = next.filter((d, i) => d !== base[i]).map((d) => d.split(':')[0]);
    expect(changed.sort()).toEqual(['--btn-radius', '--radius-base', '--radius-lg', '--radius-sm'].sort());
  });
  it('dark backgrounds select the dark colour scheme', () => {
    const dark = {
      ...DEFAULT_THEME,
      colors: { ...DEFAULT_THEME.colors, background: '#0B0B0F', text: '#F9FAFB' },
    };
    expect(compileThemeCss(dark)).toContain('color-scheme:dark');
    expect(compileThemeCss(DEFAULT_THEME)).toContain('color-scheme:light');
  });
  it('button variants differ by style and hover (not colour alone)', () => {
    const css = (b: Partial<Theme['buttons']>) =>
      compileThemeCss({ ...DEFAULT_THEME, buttons: { ...DEFAULT_THEME.buttons, ...b } });
    expect(css({ style: 'outline' })).toContain('--btn-bg:transparent');
    expect(css({ style: 'ghost' })).toContain('--btn-border:transparent');
    expect(css({ hover: 'lift' })).toContain('--btn-hover-transform:translateY(-2px)');
    expect(css({ shape: 'pill' })).toContain('--btn-radius:9999px');
    expect(css({ hover: 'none' })).toContain('--btn-hover-shadow:none');
  });
  it('rejects invalid themes and the safe wrapper falls back to the default', () => {
    const bad = { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, primary: 'red;}body{display:none' } };
    expect(() => compileThemeCss(bad as Theme)).toThrow();
    const r = compileThemeCssSafe(bad);
    expect(r.fallback).toBe(true);
    expect(r.css).toBe(compileThemeCss(DEFAULT_THEME));
    expect(compileThemeCssSafe(null).fallback).toBe(true);
    expect(compileThemeCssSafe(DEFAULT_THEME).fallback).toBe(false);
  });
  it('property: any valid theme compiles to inert, printable, balanced CSS (1,500 random themes)', () => {
    const rand = rng(20261105);
    for (let i = 0; i < 1500; i++) {
      const theme = randomTheme(rand);
      const css = compileThemeCss(theme);
      expect(css).toMatch(/^:root\{[\x20-\x7e]+\}$/); // printable ASCII, a single block
      expect(css).not.toMatch(/[<>@\\\n]|url\(|expression|javascript|\/\*/i);
      expect(css.split('{').length).toBe(2);
      expect(css.split('}').length).toBe(2);
      for (const d of themeDeclarations(theme)) expect(d).toMatch(/^(--[a-z0-9-]+|color-scheme):[^;{}]+$/);
    }
  });
  it('contrast issues are reported for weak palettes', () => {
    const weak = { ...DEFAULT_THEME, colors: { ...DEFAULT_THEME.colors, text: '#9CA3AF' } };
    expect(contrastIssues(weak).map((i) => i.pair)).toContain('text on background');
    const outline = {
      ...DEFAULT_THEME,
      buttons: { ...DEFAULT_THEME.buttons, style: 'outline' as const },
      colors: { ...DEFAULT_THEME.colors, primary: '#60A5FA' },
    };
    expect(contrastIssues(outline).length).toBeGreaterThan(0);
  });
});
