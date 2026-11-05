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

describe('onboarding manifest: hours, photos and repeating groups (FR-ONB-02)', () => {
  const withList = () => {
    const t = tpl();
    t.manifest.fields.push(
      { key: 'opening-hours', label: 'Opening hours', kind: 'hours', path: 'business.hours', required: true },
      {
        key: 'services',
        label: 'Your services',
        kind: 'list',
        path: 'pages.0.sections.1.props.items',
        required: true,
        maxItems: 8,
        itemFields: [
          { key: 'title', label: 'Name', kind: 'text', required: true, maxLength: 80 },
          { key: 'price', label: 'Price', kind: 'text', required: false },
        ],
      },
    );
    return t;
  };
  it('accepts hours and a list whose columns exist in the default items', () => {
    expect(templateSchema.safeParse(withList()).success).toBe(true);
  });
  it('rejects kind/shape mismatches, missing itemFields, unknown columns and misplaced options', () => {
    const t1 = withList();
    t1.manifest.fields[3].path = 'business.name'; // list pointing at a string
    expect(templateSchema.safeParse(t1).success).toBe(false);
    const t2 = withList();
    delete t2.manifest.fields[4].itemFields;
    expect(templateSchema.safeParse(t2).success).toBe(false);
    const t3 = withList();
    t3.manifest.fields[4].itemFields[0].key = 'nonexistent';
    expect(templateSchema.safeParse(t3).success).toBe(false);
    const t4 = withList();
    t4.manifest.fields[0].itemFields = t4.manifest.fields[4].itemFields;
    expect(templateSchema.safeParse(t4).success).toBe(false);
    const t5 = withList();
    t5.manifest.fields[0].maxItems = 3;
    expect(templateSchema.safeParse(t5).success).toBe(false);
    const t6 = withList();
    t6.manifest.fields[2].path = 'business.name'; // two fields, same path
    expect(templateSchema.safeParse(t6).success).toBe(false);
    const t7 = withList();
    t7.manifest.fields[3].path = 'business.name';
    t7.manifest.fields[3].kind = 'hours';
    expect(templateSchema.safeParse(t7).success).toBe(false);
  });
  it('a photo field must point at an image object, a gallery at a list of images', () => {
    const t = tpl();
    t.manifest.fields[2].path = 'business.name';
    expect(templateSchema.safeParse(t).success).toBe(false);
    const g = tpl();
    g.manifest.fields.push({
      key: 'photos',
      label: 'Photos',
      kind: 'images',
      path: 'business.hours',
      required: false,
    });
    expect(templateSchema.safeParse(g).success).toBe(false);
  });
});
