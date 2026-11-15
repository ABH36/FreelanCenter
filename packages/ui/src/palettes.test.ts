import { describe, expect, it } from 'vitest';
import { THEME_PALETTES, contrastChecks } from './color';

describe('THEME_PALETTES (P3 S5)', () => {
  it.each(THEME_PALETTES.map((p) => [p.name, p.colors] as const))(
    '%s passes every WCAG AA colour check with every button style',
    (_name, colors) => {
      for (const style of ['solid', 'outline', 'ghost'] as const)
        expect(contrastChecks(colors, style)).toEqual([]);
    },
  );

  it('has unique names', () => {
    expect(new Set(THEME_PALETTES.map((p) => p.name)).size).toBe(THEME_PALETTES.length);
  });
});
