/**
 * P3 S2: the inverse of every patch operation restores the config exactly (the basis of undo). Pure functions only;
 * the service paths are in test/integration/builder.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { type SiteConfig, applyPatch, parseSiteConfig } from '@platform/schema';
import { applyRestore, inverseFor, touchedParts } from './builder';

const raw = {
  schemaVersion: '1.0',
  business: {
    name: 'Iron Pulse Fitness',
    category: 'gym',
    phone: '+919800000000',
    address: { line1: '12 MG Road', city: 'Indore', state: 'MP', postalCode: '452001', country: 'IN' },
  },
  theme: {
    colors: {
      primary: '#E11D2E',
      secondary: '#111827',
      accent: '#FACC15',
      background: '#0B0B0F',
      surface: '#15151C',
      text: '#F9FAFB',
    },
    typography: { heading: 'Poppins', body: 'Inter', scale: 'comfortable' },
    radius: 'lg',
    spacing: 'regular',
    buttons: { style: 'solid', shape: 'pill', hover: 'lift' },
    motion: { preset: 'subtle', reducedMotionRespected: true },
  },
  pages: [
    {
      id: 'home',
      path: '/',
      title: 'Home',
      sections: [
        {
          id: 's1',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: { items: [{ title: 'Personal training', description: 'One to one' }] },
        },
        {
          id: 's2',
          type: 'contact',
          variant: 'form-map',
          visible: true,
          props: { fields: ['name', 'phone', 'message'], showMap: true },
        },
      ],
    },
    { id: 'about', path: '/about', title: 'About', sections: [] },
  ],
  navigation: { items: [{ label: 'Home', target: '/' }] },
  footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'none' },
  integrations: { analyticsId: null, metaPixelId: null, chatbot: { enabled: false } },
};

const parsed = parseSiteConfig(raw);
if (!parsed.ok) throw new Error(`fixture does not parse: ${JSON.stringify(parsed.issues)}`);
const base: SiteConfig = parsed.config;

const cases: Array<[string, unknown[]]> = [
  ['updateBusiness', [{ op: 'updateBusiness', value: { name: 'Renamed', tagline: 'New tagline' } }]],
  ['updateTheme', [{ op: 'updateTheme', value: { colors: { primary: '#000000' }, radius: 'none' } }]],
  [
    'updatePage (adds SEO where there was none)',
    [{ op: 'updatePage', pageId: 'about', title: 'About us', seo: { title: 'About' } }],
  ],
  ['updateSection', [{ op: 'updateSection', sectionId: 's1', visible: false }]],
  ['removeSection', [{ op: 'removeSection', sectionId: 's2' }]],
  ['moveSection', [{ op: 'moveSection', sectionId: 's2', toIndex: 0 }]],
  [
    'addSection then edit it in the same patch',
    [
      {
        op: 'addSection',
        pageId: 'about',
        section: {
          id: 'n1',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: { items: [{ title: 'New', description: 'Added' }] },
        },
      },
      { op: 'updateSection', sectionId: 'n1', visible: false },
    ],
  ],
  [
    'several parts at once',
    [
      { op: 'updateBusiness', value: { name: 'Multi' } },
      { op: 'moveSection', sectionId: 's1', toIndex: 1 },
      { op: 'updatePage', pageId: 'home', title: 'Start' },
    ],
  ],
];

describe('inverse of a patch (undo)', () => {
  it.each(cases)('%s: applying the inverse restores the original exactly', (_name, ops) => {
    const patched = applyPatch(base, ops);
    if (!patched.ok) throw new Error(JSON.stringify(patched.issues));
    expect(patched.config).not.toEqual(base);
    const inverse = inverseFor(base, touchedParts(base, patched.config, ops));
    // Stored as JSON, read back as JSON: the round trip must not depend on in-memory objects.
    const restored = applyRestore(patched.config, JSON.parse(JSON.stringify(inverse)));
    expect(restored.ok && restored.config).toEqual(base);
  });

  it('the inverse of an inverse is the redo: restoring twice returns to the changed config', () => {
    const ops = [{ op: 'updateBusiness', value: { name: 'Forward' } }];
    const patched = applyPatch(base, ops);
    if (!patched.ok) throw new Error('patch');
    const undo = inverseFor(base, touchedParts(base, patched.config, ops));
    const undone = applyRestore(patched.config, undo);
    if (!undone.ok) throw new Error('undo');
    const redo = inverseFor(patched.config, touchedParts(patched.config, undone.config, undo));
    const redone = applyRestore(undone.config, redo);
    expect(redone.ok && redone.config).toEqual(patched.config);
  });

  it('only the touched parts are captured, so an inverse stays small', () => {
    const ops = [{ op: 'updateSection', sectionId: 's1', visible: false }];
    const patched = applyPatch(base, ops);
    if (!patched.ok) throw new Error('patch');
    expect(touchedParts(base, patched.config, ops)).toEqual(['sections:home']);
    expect(inverseFor(base, ['sections:home']).map((o) => o.op)).toEqual(['restoreSections']);
  });

  it('a restore that would break the config is refused (no unknown pages)', () => {
    expect(applyRestore(base, [{ op: 'restoreSections', pageId: 'missing', sections: [] }]).ok).toBe(false);
  });
});
