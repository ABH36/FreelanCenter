import { describe, expect, it } from 'vitest';
import { SAMPLE_TEXTS } from '@platform/schema';
import { runPreflight } from './preflight';

const base = () => ({
  schemaVersion: '1.0',
  business: { name: 'Sharma Gym', category: 'gym', phone: '+919811111111', email: 'hi@sharma.test' },
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
          id: 'hero',
          type: 'hero',
          variant: 'centered',
          visible: true,
          props: { headline: 'Train with Sharma', primaryCta: { label: 'Call now', action: 'tel' } },
        },
      ],
    },
  ],
  navigation: { items: [{ label: 'Home', target: '/' }] },
  footer: { variant: 'simple', showPlatformBadge: true, floatingAction: 'none' },
  integrations: { analyticsId: null, metaPixelId: null, chatbot: { enabled: false } },
});

type Config = ReturnType<typeof base>;
const run = (config: Config, kind: 'staging' | 'live' = 'live', template?: unknown) =>
  runPreflight({ config, kind, ...(template ? { template } : {}) });
const rules = (r: ReturnType<typeof run>) => r.checks.map((c) => `${c.rule}:${c.level}`);
const hero = (c: Config) => c.pages[0]!.sections[0]! as { props: Record<string, unknown>; visible: boolean };

describe('runPreflight', () => {
  it('a clean site passes with no checks', () => {
    expect(run(base())).toEqual({ ok: true, checks: [] });
  });

  it('an invalid config is one blocking schema check', () => {
    const r = runPreflight({ config: { nope: true }, kind: 'staging' });
    expect(r.ok).toBe(false);
    expect(rules(r)).toEqual(['schema:blocking']);
  });

  it('demo contact details block Live and warn for Staging (decision 3), compared loosely', () => {
    const template = base();
    const site = base();
    site.business.phone = '919811111111'; // same digits, other spelling
    site.business.email = 'HI@Sharma.test';
    site.business.name = 'Another name';
    site.pages[0]!.seo = { title: 'Another name', description: 'Weights' } as never;
    const live = run(site, 'live', template);
    expect(live.ok).toBe(false);
    expect(live.checks[0]).toMatchObject({ rule: 'demo-contact', level: 'blocking' });
    expect(live.checks[0]!.message).toMatch(/sample phone number and e-mail address are/);
    const staging = run(site, 'staging', template);
    expect(staging.ok).toBe(true);
    expect(rules(staging)).toEqual(['demo-contact:warning']);
  });

  it('P3 S9d (DG-40): a page search title or description naming the demo business blocks Live and warns for Staging', () => {
    const template = base(); // its business is "Sharma Gym"
    const site = base();
    site.business.name = 'Verma Fitness';
    site.business.phone = '+919822222222';
    site.business.email = 'hi@verma.test';
    site.pages[0]!.seo = { title: 'SHARMA gym | Weights', description: 'Gym in Indore' } as never;
    const live = run(site, 'live', template);
    expect(live.ok).toBe(false);
    const check = live.checks.find((c) => c.rule === 'demo-seo');
    expect(check).toMatchObject({ level: 'blocking', where: 'Page settings' });
    expect(check!.message).toContain('"Home"');
    expect(check!.message).toContain('"Sharma Gym"');
    expect(run(site, 'staging', template).checks.find((c) => c.rule === 'demo-seo')?.level).toBe('warning');
    // Fixed texts, no template to compare with, or a business that kept the demo name: no check.
    site.pages[0]!.seo = { title: 'Verma Fitness | Weights', description: 'Gym in Indore' } as never;
    expect(run(site, 'live', template).checks.some((c) => c.rule === 'demo-seo')).toBe(false);
    site.pages[0]!.seo = { title: 'Sharma Gym', description: 'Gym in Indore' } as never;
    expect(run(site, 'live').checks.some((c) => c.rule === 'demo-seo')).toBe(false);
    expect(run(template, 'live', template).checks.some((c) => c.rule === 'demo-seo')).toBe(false);
  });

  it('a call button without a phone, a link to a missing page and a scroll to a hidden section are broken links', () => {
    const c = base();
    delete (c.business as { phone?: string }).phone;
    (c.pages[0]!.sections as unknown[]).push(
      {
        id: 'about',
        type: 'about',
        variant: 'text-only',
        visible: true,
        props: {
          heading: 'About',
          body: [{ type: 'link', text: 'Prices', href: '/prices' }],
        },
      },
      {
        id: 'banner',
        type: 'cta-banner',
        variant: 'solid',
        visible: true,
        props: { headline: 'Come in', cta: { label: 'See FAQ', action: 'scroll', target: '#faq' } },
      },
    );
    const r = run(c);
    expect(r.ok).toBe(false);
    expect(r.checks.filter((x) => x.rule === 'broken-link').map((x) => x.message)).toEqual([
      'The button "Call now" needs a phone number in Business details.',
      'The text link "Prices" goes to a page that does not exist.',
      'The button "See FAQ" goes to a section that does not exist or is hidden.',
    ]);
    expect(run(c, 'staging').ok).toBe(true);
  });

  it('a floating WhatsApp button falls back to the phone; without either it is broken', () => {
    const c = base();
    c.footer.floatingAction = 'whatsapp';
    expect(run(c).ok).toBe(true);
    delete (c.business as { phone?: string }).phone;
    hero(c).props['primaryCta'] = { label: 'Mail us', action: 'mailto' };
    expect(rules(run(c))).toContain('broken-link:blocking');
  });

  it('a contact form warns that messages are not delivered yet (decision 2); the details variant does not', () => {
    const c = base();
    (c.pages[0]!.sections as unknown[]).push({
      id: 'contact',
      type: 'contact',
      variant: 'form-only',
      visible: true,
      props: { fields: ['name', 'phone', 'message'] },
    });
    const r = run(c);
    expect(r.ok).toBe(true);
    expect(rules(r)).toEqual(['form-destination:warning']);
    (c.pages[0]!.sections[1] as { variant: string }).variant = 'details';
    expect(run(c).checks).toEqual([]);
  });

  it('placeholder text, weak alt text, long words, missing SEO and contrast are warnings', () => {
    const c = base();
    const sample = SAMPLE_TEXTS[0]!;
    hero(c).props['headline'] = sample;
    hero(c).props['subheadline'] = 'Supercalifragilisticexpialidociousness everywhere';
    hero(c).props['image'] = { assetId: 'a1', alt: 'IMG_2041.jpg' };
    c.pages[0]!.seo = { title: 'Sharma Gym' } as never;
    c.theme.colors.text = '#222222';
    const r = run(c);
    expect(r.ok).toBe(true);
    expect(rules(r).sort()).toEqual(
      [
        'alt-text:warning',
        'contrast:warning',
        'mobile-overflow:warning',
        'placeholder-text:warning',
        'seo:warning',
      ].sort(),
    );
    expect(r.checks.find((x) => x.rule === 'seo')!.message).toMatch(/no search description/);
    expect(r.checks.find((x) => x.rule === 'placeholder-text')!.where).toBe('Home > Hero');
  });

  it('hidden sections are not checked; a home page with nothing visible warns', () => {
    const c = base();
    hero(c).props['headline'] = SAMPLE_TEXTS[0]!;
    hero(c).visible = false;
    const r = run(c);
    expect(rules(r)).toEqual(['empty-page:warning']);
  });

  it('caps each rule at 8 and summarises the rest; blocking checks come first', () => {
    const c = base();
    const sections = c.pages[0]!.sections as unknown[];
    for (let i = 0; i < 12; i++) {
      sections.push({
        id: `b${i}`,
        type: 'cta-banner',
        variant: 'solid',
        visible: true,
        props: { headline: `Offer ${i}`, cta: { label: `Go ${i}`, action: 'link', target: `/missing-${i}` } },
      });
    }
    hero(c).props['headline'] = SAMPLE_TEXTS[0]!;
    const r = run(c);
    const broken = r.checks.filter((x) => x.rule === 'broken-link');
    expect(broken).toHaveLength(9);
    expect(broken[8]!.message).toBe('And 4 more like this.');
    expect(r.checks[0]!.level).toBe('blocking');
    expect(r.checks[r.checks.length - 1]!.level).toBe('warning');
  });
});
