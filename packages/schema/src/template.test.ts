/* eslint-disable @typescript-eslint/no-explicit-any -- mutation helpers edit untyped documents on purpose */
import { describe, expect, it } from 'vitest';
import { getAtPath, templateSchema } from './index';
import { validConfig } from './fixtures';

type Mutable = Record<string, any>;
function tpl(): Mutable {
  return {
    id: 'gym-bold',
    version: 1,
    name: 'Gym Bold',
    category: 'gym',
    description: 'A bold, dark template for gyms and studios.',
    tags: ['dark', 'bold'],
    config: validConfig(),
    manifest: {
      fields: [
        {
          key: 'business-name',
          label: 'Business name',
          kind: 'text',
          path: 'business.name',
          required: true,
          maxLength: 80,
        },
        {
          key: 'headline',
          label: 'Main headline',
          kind: 'text',
          path: 'pages.0.sections.0.props.headline',
          required: true,
        },
        {
          key: 'hero-image',
          label: 'Hero photo',
          kind: 'image',
          path: 'pages.0.sections.0.props.image',
          required: false,
        },
      ],
    },
  };
}
const bad = (fn: (t: Mutable) => void) => {
  const t = tpl();
  fn(t);
  return templateSchema.safeParse(t).success;
};

describe('templateSchema', () => {
  it('accepts a valid template', () => {
    expect(templateSchema.safeParse(tpl()).success).toBe(true);
  });
  it('rejects unknown keys, category mismatch and invalid embedded config', () => {
    expect(bad((t) => (t.script = 'x'))).toBe(false);
    expect(bad((t) => (t.category = 'taxi'))).toBe(false);
    expect(bad((t) => (t.category = 'nope'))).toBe(false);
    expect(bad((t) => (t.config.pages[0].sections[0].type = 'script'))).toBe(false);
    expect(bad((t) => (t.id = 'Bad Id'))).toBe(false);
  });
  it('manifest paths must resolve; duplicates and prototype paths are refused', () => {
    expect(bad((t) => (t.manifest.fields[0].path = 'business.missing'))).toBe(false);
    expect(bad((t) => (t.manifest.fields[0].path = 'business'))).toBe(false);
    expect(bad((t) => (t.manifest.fields[0].path = 'constructor.name'))).toBe(false);
    expect(bad((t) => (t.manifest.fields[0].path = '__proto__.x'))).toBe(false);
    expect(bad((t) => (t.manifest.fields[1].key = 'business-name'))).toBe(false);
    expect(bad((t) => (t.manifest.fields = []))).toBe(false);
  });
  it('getAtPath reads own properties only', () => {
    const c = validConfig();
    expect(getAtPath(c, 'business.name')).toBe('Iron Pulse Fitness');
    expect(getAtPath(c, 'pages.1.id')).toBe('about');
    expect(getAtPath(c, 'business.toString')).toBeUndefined();
    expect(getAtPath(c, 'pages.length')).toBeUndefined();
  });
});
