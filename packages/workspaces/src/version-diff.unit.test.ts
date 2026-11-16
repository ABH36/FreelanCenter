/**
 * P3 S7b: the structured diff of two versions (FR-PUB-03 JSON diff). Pure function; the service path is in
 * test/integration/publishing.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { type SiteConfig, parseSiteConfig } from '@platform/schema';
import { DIFF_LIMITS, diffConfigs } from './version-diff';

const raw = {
  schemaVersion: '1.0',
  business: { name: 'Sharma Gym', category: 'gym', phone: '+919811111111', address: { city: 'Indore' } },
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
      seo: { title: 'Sharma Gym', description: 'Gym in Indore' },
      sections: [
        {
          id: 's1',
          type: 'services',
          variant: 'cards-3',
          visible: true,
          props: {
            items: [
              { title: 'Personal training', description: 'One to one' },
              { title: 'Yoga', description: 'Mornings' },
            ],
          },
        },
        {
          id: 's2',
          type: 'faq',
          variant: 'accordion',
          visible: true,
          props: {
            items: [{ question: 'Open on Sunday?', answer: [{ type: 'text', text: 'Yes, 7 to 12.' }] }],
          },
        },
      ],
    },
    { id: 'about', path: '/about', title: 'About', sections: [] },
  ],
  navigation: { items: [{ label: 'Home', target: '/' }] },
  footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'none' },
  integrations: { analyticsId: null, metaPixelId: null, chatbot: { enabled: false } },
};

function config(change?: (c: typeof raw) => void): SiteConfig {
  const copy = structuredClone(raw);
  change?.(copy);
  const parsed = parseSiteConfig(copy);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.config;
}

describe('diffConfigs (FR-PUB-03)', () => {
  it('two equal versions have no differences', () => {
    expect(diffConfigs(config(), config())).toEqual({ entries: [], more: 0, same: true });
  });

  it('business and theme changes are field by field, in words', () => {
    const d = diffConfigs(
      config(),
      config((c) => {
        c.business.phone = '+919822222222';
        c.business.address.city = 'Bhopal';
        c.theme.colors.primary = '#0055FF';
      }),
    );
    expect(d.same).toBe(false);
    expect(d.entries).toEqual([
      {
        area: 'business',
        change: 'changed',
        where: 'Business details',
        field: 'Phone',
        before: '+919811111111',
        after: '+919822222222',
      },
      {
        area: 'business',
        change: 'changed',
        where: 'Business details',
        field: 'Address > City',
        before: 'Indore',
        after: 'Bhopal',
      },
      {
        area: 'theme',
        change: 'changed',
        where: 'Theme',
        field: 'Colors > Primary',
        before: '#E11D2E',
        after: '#0055FF',
      },
    ]);
  });

  it('a section field change names the list item; rich text is shown as plain text', () => {
    const d = diffConfigs(
      config(),
      config((c) => {
        (c.pages[0]!.sections[0]!.props.items as { title: string }[])[1]!.title = 'Power yoga';
        (c.pages[0]!.sections[1]!.props.items as { answer: { type: string; text: string }[] }[])[0]!.answer =
          [{ type: 'text', text: 'No, closed.' }];
      }),
    );
    expect(d.entries).toEqual([
      {
        area: 'section',
        change: 'changed',
        where: 'Home > Services',
        path: '/',
        field: 'Items 2 > Title',
        before: 'Yoga',
        after: 'Power yoga',
      },
      {
        area: 'section',
        change: 'changed',
        where: 'Home > Faq',
        path: '/',
        field: 'Items 1 > Answer',
        before: 'Yes, 7 to 12.',
        after: 'No, closed.',
      },
    ]);
  });

  it('sections added, removed, moved, hidden and layout changes', () => {
    const d = diffConfigs(
      config(),
      config((c) => {
        const [services, faq] = c.pages[0]!.sections as unknown[] as [
          (typeof c.pages)[0]['sections'][0],
          (typeof c.pages)[0]['sections'][0],
        ];
        faq.visible = false;
        services.variant = 'list';
        c.pages[0]!.sections = [faq, services];
        c.pages[1]!.sections = [
          { id: 's9', type: 'services', variant: 'cards-3', visible: true, props: { items: [] } },
        ] as never;
      }),
    );
    const kinds = d.entries.map((e) => `${e.where}: ${e.change}${e.field ? ` ${e.field}` : ''}`);
    expect(kinds).toEqual([
      'Home > Faq: moved',
      'Home > Faq: hidden',
      'Home > Services: moved',
      'Home > Services: changed Layout',
      'About > Services: added',
    ]);
    const back = diffConfigs(
      config((c) => {
        c.pages[1]!.sections = [
          { id: 's9', type: 'services', variant: 'cards-3', visible: true, props: { items: [] } },
        ] as never;
      }),
      config(),
    );
    expect(back.entries).toEqual([{ area: 'section', change: 'removed', where: 'About > Services' }]);
  });

  it('pages added, removed, renamed and their search fields; a section moved to another page', () => {
    const d = diffConfigs(
      config(),
      config((c) => {
        c.pages[0]!.title = 'Start';
        c.pages[0]!.seo!.title = 'Sharma Gym Indore';
        const faq = c.pages[0]!.sections.pop()!;
        c.pages[1]!.sections = [faq];
        c.pages.push({ id: 'prices', path: '/prices', title: 'Prices', sections: [] });
      }),
    );
    expect(
      d.entries.map((e) => [e.area, e.change, e.where, e.field ?? '', e.before ?? '', e.after ?? '']),
    ).toEqual([
      ['page', 'changed', 'Start', 'Title', 'Home', 'Start'],
      ['page', 'changed', 'Start', 'Search > Title', 'Sharma Gym', 'Sharma Gym Indore'],
      ['page', 'added', 'Prices', '', '', ''],
      ['section', 'moved', 'About > Faq', '', 'Home', 'About'],
    ]);
    const removed = diffConfigs(
      config(),
      config((c) => void c.pages.pop()),
    );
    expect(removed.entries).toEqual([{ area: 'page', change: 'removed', where: 'About' }]);
  });

  it('values are clipped and the list is capped with a count of the rest', () => {
    const long = 'x'.repeat(200);
    const d = diffConfigs(
      config(),
      config(
        (c) => ((c.pages[0]!.sections[0]!.props.items as { description: string }[])[0]!.description = long),
      ),
    );
    expect(d.entries[0]!.after!.length).toBe(DIFF_LIMITS.valueChars);
    expect(d.entries[0]!.after!.endsWith('…')).toBe(true);

    const many = config((c) => {
      c.pages[0]!.sections[0]!.props.items = Array.from({ length: 12 }, (_, i) => ({
        title: `T${i}`,
        description: `D${i}`,
      }));
    });
    const changed = config((c) => {
      c.pages[0]!.sections[0]!.props.items = Array.from({ length: 12 }, (_, i) => ({
        title: `U${i}`,
        description: `E${i}`,
      }));
    });
    expect(diffConfigs(many, changed).entries).toHaveLength(24);
    const capped = diffConfigs(many, changed, { limit: 5 });
    expect(capped.entries).toHaveLength(5);
    expect(capped.more).toBe(19);
  });
});
