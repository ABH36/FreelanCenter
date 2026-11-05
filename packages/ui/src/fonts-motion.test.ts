import { ENTER_ANIMATIONS, FONTS, MOTION_PRESETS } from '@platform/schema';
import { describe, expect, it } from 'vitest';
import {
  FONT_SLUGS,
  FONT_WEIGHTS,
  fontFaceCss,
  fontFiles,
  fontStack,
  subsetsOf,
  themeFontFaceCss,
  themeFonts,
  themePreloads,
} from './fonts';
import { MOTION_VALUES, enterClass, motionCss, motionVariables } from './motion';
import { DEFAULT_THEME } from './theme';

describe('font policy (Q19)', () => {
  it('covers the whole schema allow-list and nothing else', () => {
    expect(FONT_SLUGS).toHaveLength(FONTS.length);
    expect(new Set(FONT_SLUGS).size).toBe(FONTS.length);
    for (const f of FONTS) {
      expect(subsetsOf(f.name).includes('devanagari')).toBe(f.devanagari);
      expect(fontFiles(f.name)).toHaveLength(subsetsOf(f.name).length * FONT_WEIGHTS.length);
    }
  });
  it('declares self-hosted faces with swap and unicode-range, no third-party URL', () => {
    for (const f of FONTS) {
      const css = fontFaceCss(f.name);
      expect(css).not.toMatch(/https?:|\/\/|@import/);
      expect(css.match(/font-display:swap/g)).toHaveLength(fontFiles(f.name).length);
      expect(css.match(/unicode-range:/g)).toHaveLength(fontFiles(f.name).length);
      expect(css).toContain(`font-family:"${f.name}"`);
    }
    expect(fontFaceCss('Poppins')).toContain('url(/fonts/poppins-devanagari-700-normal.woff2)');
    expect(fontFaceCss('Inter')).not.toContain('devanagari-');
  });
  it('rejects unsafe base paths', () => {
    for (const base of ['//evil.com', 'https://evil.com', '/a b', '/fonts"x', '', '/../x', 'fonts']) {
      expect(() => fontFaceCss('Inter', base)).toThrow();
      expect(() => themePreloads(DEFAULT_THEME, base)).toThrow();
    }
  });
  it('stacks quote names, fall back to system fonts and add a Devanagari fallback where glyphs are missing', () => {
    expect(fontStack('Inter')).toBe(
      '"Inter", "Noto Sans Devanagari", "Nirmala UI", system-ui, -apple-system, "Segoe UI", sans-serif',
    );
    expect(fontStack('Poppins')).not.toContain('Nirmala');
    expect(fontStack('Playfair Display').endsWith('serif')).toBe(true);
  });
  it('declares and preloads only the fonts a theme uses, latin only', () => {
    const same = { typography: { heading: 'Inter', body: 'Inter', scale: 'comfortable' } } as const;
    expect(themeFonts(same)).toEqual(['Inter']);
    expect(themePreloads(same)).toEqual([
      '/fonts/inter-latin-400-normal.woff2',
      '/fonts/inter-latin-700-normal.woff2',
    ]);
    const pair = { typography: { heading: 'Poppins', body: 'Hind', scale: 'comfortable' } } as const;
    expect(themeFonts(pair)).toEqual(['Poppins', 'Hind']);
    expect(themePreloads(pair).every((p) => p.includes('-latin-'))).toBe(true);
    expect(themeFontFaceCss(pair)).not.toContain('Inter');
  });
});

describe('animation presets (FR-TPL-05)', () => {
  it('preset none has zero duration and no enter class', () => {
    expect(MOTION_VALUES.none.duration).toBe('0ms');
    for (const e of ENTER_ANIMATIONS) expect(enterClass('none', e)).toBeUndefined();
  });
  it('subtle is gentler than energetic', () => {
    expect(parseInt(MOTION_VALUES.subtle.duration)).toBeLessThan(parseInt(MOTION_VALUES.energetic.duration));
    expect(parseInt(MOTION_VALUES.subtle.distance)).toBeLessThan(parseInt(MOTION_VALUES.energetic.distance));
    for (const p of MOTION_PRESETS) expect(motionVariables(p)).toContain('--motion-duration:');
  });
  it('maps every enter animation to a class that has keyframes and a rule', () => {
    const css = motionCss();
    for (const e of ENTER_ANIMATIONS.filter((x) => x !== 'none')) {
      const cls = enterClass('subtle', e);
      expect(cls).toBe(`enter-${e}`);
      expect(css).toContain(`@keyframes enter-${e}`);
      expect(css).toContain(`.enter-${e}{animation-name:enter-${e}}`);
    }
    expect(enterClass('subtle', undefined)).toBeUndefined();
    expect(enterClass('energetic', 'none')).toBeUndefined();
  });
  it('honours prefers-reduced-motion for every animation and transition', () => {
    const css = motionCss();
    expect(css).toMatch(
      /@media \(prefers-reduced-motion:reduce\)\{[^}]*animation:none!important;transition:none!important/,
    );
  });
  it('keeps content visible without animation support (hidden state only inside keyframes) and is tenant-free', () => {
    const css = motionCss();
    expect(css).not.toMatch(/\.enter-[a-z-]+\{[^}]*opacity:0/);
    expect(css).not.toMatch(/url\(|https?:|@import/);
    expect(motionCss()).toBe(css);
  });
});
