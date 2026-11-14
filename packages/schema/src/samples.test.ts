import { describe, expect, it } from 'vitest';
import {
  BLOCKS,
  BLOCK_TYPES,
  applyPatch,
  parseSiteConfig,
  sampleSection,
  sectionSchema,
  SAMPLE_TEXTS,
} from './index';
import { validConfig } from './fixtures';

describe('sampleSection (P3 S4)', () => {
  it.each(BLOCK_TYPES.flatMap((type) => BLOCKS[type].variants.map((variant) => [type, variant] as const)))(
    '%s / %s is a valid section that a page accepts',
    (type, variant) => {
      const section = sampleSection(type, variant, 'new-1');
      expect(sectionSchema.safeParse(section).success).toBe(true);
      const parsed = parseSiteConfig(validConfig());
      if (!parsed.ok) throw new Error('fixture');
      const r = applyPatch(parsed.config, [{ op: 'addSection', pageId: 'about', section }]);
      expect(r.ok).toBe(true);
    },
  );

  it('returns a fresh copy each time and lists its placeholder texts', () => {
    const a = sampleSection('services', 'cards-3', 'a');
    (a.props as { heading?: string }).heading = 'Changed';
    expect((sampleSection('services', 'cards-3', 'b').props as { heading?: string }).heading).toBe(
      'Our services',
    );
    expect(SAMPLE_TEXTS).toContain('Your headline here');
    expect(SAMPLE_TEXTS).toContain('Service name');
  });
});
