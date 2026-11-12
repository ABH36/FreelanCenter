import { describe, expect, it } from 'vitest';
import type { Section } from '@platform/schema';
import {
  CHROME,
  Footer,
  FloatingActions,
  Header,
  createRegistry,
  expandNode,
  registry,
  renderSection,
  renderSections,
  resolveCta,
  resolveHref,
  type BlockDefinition,
  type BlockErrorInfo,
} from './index';
import { z } from 'zod';
import { allDefaultSections, baseConfig, ctxFor, html, parsed } from './test-helpers';

const config = () => parsed(baseConfig());
const section = (type: string, variant: string, props: unknown, extra: Record<string, unknown> = {}) =>
  ({ id: 'x1', type, variant, visible: true, props, ...extra }) as Section;

function renderAll(overrides = {}) {
  const cfg = parsed(baseConfig(allDefaultSections()));
  const ctx = ctxFor(cfg, overrides);
  const sections = cfg.pages[0]?.sections ?? [];
  return { cfg, ctx, ...renderSections(sections, ctx) };
}

describe('every block and variant renders', () => {
  it('renders all 12 sections x variants to non-empty, script-free, style-free markup', () => {
    const errors: BlockErrorInfo[] = [];
    const { nodes } = renderAll({ onBlockError: (e: BlockErrorInfo) => errors.push(e) });
    expect(errors).toEqual([]);
    const expected = registry.list().reduce((n, d) => n + d.variants.length, 0);
    expect(nodes).toHaveLength(expected);
    for (const { id, node } of nodes) {
      const out = html(node);
      expect(out.length, id).toBeGreaterThan(40);
      expect(out, id).not.toMatch(/<script|<iframe|<object|<embed|javascript:|\sstyle=|\son[a-z]+=/i);
    }
  });
  it('gives the page exactly one h1 (the first hero) and heads other sections with h2', () => {
    const { nodes, h1Used } = renderAll();
    const out = nodes.map((n) => html(n.node)).join('');
    expect(h1Used).toBe(true);
    expect(out.match(/<h1[ >]/g)).toHaveLength(1);
    expect(out).toContain('<h2');
  });
  it('without a hero no block claims the h1 (the page supplies one)', () => {
    const cfg = parsed(
      baseConfig([section('about', 'text-only', registry.get('about')?.defaults('text-only'))]),
    );
    const r = renderSections(cfg.pages[0]?.sections ?? [], ctxFor(cfg));
    expect(r.h1Used).toBe(false);
    expect(html(r.nodes[0]?.node)).not.toContain('<h1');
  });
  it('skips hidden sections', () => {
    const cfg = parsed(baseConfig([section('map', 'link-card', {}, { visible: false })]));
    expect(renderSections(cfg.pages[0]?.sections ?? [], ctxFor(cfg)).nodes).toEqual([]);
  });
});

describe('animation and priority', () => {
  const two = () =>
    parsed(
      baseConfig([
        section('hero', 'centered', registry.get('hero')?.defaults('centered'), {
          id: 'a',
          motion: { enter: 'fade-up' },
        }),
        section('map', 'link-card', {}, { id: 'b', motion: { enter: 'fade-up' } }),
      ]),
    );
  it('the first section has no enter animation (LCP); later ones follow the preset', () => {
    const cfg = two();
    const out = renderSections(cfg.pages[0]?.sections ?? [], ctxFor(cfg)).nodes.map((n) => html(n.node));
    expect(out[0]).not.toContain('enter-');
    expect(out[1]).toContain('enter-fade-up');
  });
  it('preset none removes enter animations everywhere', () => {
    const cfg = two();
    const out = renderSections(cfg.pages[0]?.sections ?? [], ctxFor(cfg, { motionPreset: 'none' })).nodes.map(
      (n) => html(n.node),
    );
    expect(out.join('')).not.toContain('enter-');
  });
});

describe('isolation (FR-TPL-06): one bad block never takes the page down', () => {
  const boom: BlockDefinition<Record<string, never>> = {
    type: 'boom',
    label: 'Boom',
    description: 'throws while rendering',
    variants: [{ id: 'v', label: 'v' }],
    schema: z.strictObject({}) as unknown as z.ZodType<Record<string, never>>,
    fields: [],
    defaults: () => ({}),
    render() {
      const Child = () => {
        throw new Error('secret tenant text: 555-0100');
      };
      return (
        <div>
          <Child />
        </div>
      );
    },
  };
  const ok: BlockDefinition<Record<string, never>> = {
    ...boom,
    type: 'fine',
    render: () => <p>fine block</p>,
  };
  const reg = createRegistry([boom, ok] as unknown as BlockDefinition[], CHROME);
  const cfg = config();
  const secs = [section('boom', 'v', {}, { id: 'b1' }), section('fine', 'v', {}, { id: 'f1' })];

  it('a throw inside a nested component is caught at that block; the next block still renders', () => {
    const errors: BlockErrorInfo[] = [];
    const r = renderSections(secs, ctxFor(cfg, { onBlockError: (e) => errors.push(e) }), { registry: reg });
    expect(r.nodes.map((n) => n.id)).toEqual(['f1']);
    expect(html(r.nodes[0]?.node)).toContain('fine block');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ sectionId: 'b1', type: 'boom', stage: 'render' });
  });
  it('the report carries no tenant text or props', () => {
    const errors: BlockErrorInfo[] = [];
    renderSections(secs, ctxFor(cfg, { onBlockError: (e) => errors.push(e) }), { registry: reg });
    expect(JSON.stringify(errors)).not.toContain('555-0100');
  });
  it('preview and draft show a visible placeholder in place of the block, in the right language', () => {
    for (const mode of ['preview', 'draft'] as const) {
      const r = renderSections(secs, ctxFor(cfg, { mode }), { registry: reg });
      expect(r.nodes).toHaveLength(2);
      expect(html(r.nodes[0]?.node)).toContain('could not be displayed');
    }
    const hi = parsed(baseConfig([], { business: { ...baseConfig().business, language: 'hi' } }));
    expect(
      html(renderSections(secs, ctxFor(hi, { mode: 'preview' }), { registry: reg }).nodes[0]?.node),
    ).toContain('दिखाया नहीं जा सका');
  });
  it('invalid props are never rendered (stage props) and unknown blocks are reported (unknown-block)', () => {
    const errors: BlockErrorInfo[] = [];
    const ctx = ctxFor(config(), { onBlockError: (e) => errors.push(e) });
    const bad = section('hero', 'centered', { headline: '<script>alert(1)</script>' });
    expect(renderSection(bad, ctx, { registry, asH1: true, priority: true })).toBeNull();
    expect(
      renderSection(section('nope', 'v', {}), ctx, { registry, asH1: false, priority: false }),
    ).toBeNull();
    expect(
      renderSection(section('hero', 'nope', {}), ctx, { registry, asH1: false, priority: false }),
    ).toBeNull();
    expect(errors.map((e) => e.stage)).toEqual(['props', 'unknown-block', 'unknown-block']);
    expect(errors[0]?.message).toBe('Invalid props at headline');
  });
  it('a reporter that throws cannot break rendering', () => {
    const ctx = ctxFor(cfg, {
      onBlockError: () => {
        throw new Error('reporter down');
      },
    });
    expect(() => renderSections(secs, ctx, { registry: reg })).not.toThrow();
  });
  it('expandNode bounds runaway nesting', () => {
    const Loop = (): React.ReactNode => <Loop />;
    expect(() => expandNode(<Loop />)).toThrow(/nested too deeply/);
  });
  it('a new block needs no change to the renderer core (acceptance: extensible registry)', () => {
    const banner: BlockDefinition<{ text: string }> = {
      type: 'announcement',
      label: 'Announcement',
      description: 'A test-only block registered at runtime',
      variants: [{ id: 'bar', label: 'Bar' }],
      schema: z.strictObject({ text: z.string().max(80) }),
      fields: [],
      defaults: () => ({ text: 'hello' }),
      render: ({ props }) => <p className="announce">{props.text}</p>,
    };
    const custom = createRegistry([...registry.list(), banner] as unknown as BlockDefinition[], CHROME);
    const r = renderSections([section('announcement', 'bar', { text: 'Diwali sale' })], ctxFor(config()), {
      registry: custom,
    });
    expect(html(r.nodes[0]?.node)).toContain('Diwali sale');
  });
});

describe('text is data: hostile strings are escaped, never interpreted', () => {
  it('quotes, ampersands and entity lookalikes come out escaped', () => {
    const cfg = parsed(baseConfig());
    const props = { headline: `Tom & "Jerry" 'x' &lt;b&gt; onerror=alert(1)` };
    const out = html(
      renderSection(section('hero', 'centered', props), ctxFor(cfg), {
        registry,
        asH1: true,
        priority: true,
      }),
    );
    expect(out).toContain('Tom &amp; &quot;Jerry&quot; &#x27;x&#x27; &amp;lt;b&amp;gt; onerror=alert(1)');
    expect(out).not.toMatch(/<b>|<img|<script/);
  });
});

describe('CTA and links', () => {
  const biz = config().business;
  it('resolves each action from the business contact details', () => {
    expect(resolveCta({ label: 'W', action: 'whatsapp' }, biz)).toEqual({
      href: 'https://wa.me/919800000001?text=Hi%20Iron%20Pulse%20Fitness%2C%20I%20found%20your%20website%20and%20would%20like%20to%20know%20more.',
      label: 'W',
      external: true,
    });
    expect(resolveCta({ label: 'T', action: 'tel' }, biz)?.href).toBe('tel:+919800000000');
    expect(resolveCta({ label: 'M', action: 'mailto' }, biz)?.href).toBe('mailto:hello@example.com');
    expect(resolveCta({ label: 'S', action: 'scroll', target: '#contact' }, biz)).toEqual({
      href: '#contact',
      label: 'S',
      external: false,
    });
    expect(resolveCta({ label: 'L', action: 'link', target: 'https://example.com' }, biz)?.external).toBe(
      true,
    );
  });
  it('returns null (so no dead button is rendered) when the contact detail is missing or the target unsafe', () => {
    const empty = { ...biz, phone: '', whatsapp: '', email: '' };
    for (const action of ['whatsapp', 'tel', 'mailto'] as const)
      expect(resolveCta({ label: 'x', action }, empty)).toBeNull();
    expect(resolveCta({ label: 'x', action: 'link' }, biz)).toBeNull();
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com', 'http://x.com', '/a/../b']) {
      expect(resolveHref(bad), bad).toBeNull();
    }
  });
  it('tel falls back to the WhatsApp number when there is no phone', () => {
    expect(resolveCta({ label: 'T', action: 'tel' }, { ...biz, phone: '' })?.href).toBe('tel:+919800000001');
  });
  it('external buttons open safely and announce it; missing WhatsApp renders no button at all', () => {
    const cfg = parsed(baseConfig());
    const props = { headline: 'Hi', primaryCta: { label: 'Chat', action: 'whatsapp' } };
    const out = html(
      renderSection(section('hero', 'centered', props), ctxFor(cfg), {
        registry,
        asH1: true,
        priority: true,
      }),
    );
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('opens in a new tab');
    const none = parsed(baseConfig([], { business: { ...baseConfig().business, whatsapp: '' } }));
    expect(
      html(
        renderSection(section('hero', 'centered', props), ctxFor(none), {
          registry,
          asH1: true,
          priority: true,
        }),
      ),
    ).not.toContain('wa.me');
  });
});

describe('contact, images, language', () => {
  const contactSection = section('contact', 'form-map', {
    fields: ['name', 'phone', 'email', 'message'],
    showMap: true,
  });
  it('shows no form until a lead endpoint exists, only details and buttons', () => {
    const cfg = config();
    const out = html(renderSection(contactSection, ctxFor(cfg), { registry, asH1: false, priority: false }));
    expect(out).not.toContain('<form');
    expect(out).toContain('wa.me');
    expect(out).toContain('Open in Maps');
  });
  it('renders a labelled, accessible form when a lead endpoint is provided', () => {
    const cfg = config();
    const out = html(
      renderSection(contactSection, ctxFor(cfg, { leadForm: { action: '/api/leads' } }), {
        registry,
        asH1: false,
        priority: false,
      }),
    );
    expect(out).toContain('<form');
    expect(out).toContain('action="/api/leads"');
    for (const f of ['name', 'phone', 'email', 'message']) expect(out).toContain(`for="x1-${f}"`);
    expect(out.toLowerCase()).toContain('autocomplete="tel"');
  });
  it('uses responsive pre-generated widths with lazy loading, eager for the first image', () => {
    const cfg = config();
    const assetUrl = (id: string, w: number) => `https://assets.example.test/${id}-${w}.webp`;
    const props = { headline: 'Hi', image: { assetId: 'hero-1', alt: 'Gym floor' } };
    const first = html(
      renderSection(section('hero', 'split-image', props), ctxFor(cfg, { assetUrl }), {
        registry,
        asH1: true,
        priority: true,
      }),
    );
    expect(first.toLowerCase()).toContain('srcset="https://assets.example.test/hero-1-400.webp 400w');
    expect(first).toContain('1600w');
    expect(first).toContain('loading="eager"');
    expect(first.toLowerCase()).toContain('fetchpriority="high"');
    expect(first).toContain('alt="Gym floor"');
    const later = html(
      renderSection(
        section('about', 'text-image', { heading: 'A', body: [], image: props.image }),
        ctxFor(cfg, { assetUrl }),
        { registry, asH1: false, priority: false },
      ),
    );
    expect(later).toContain('loading="lazy"');
  });
  it('shows a decorative placeholder while the asset is unavailable (no photo is announced that nobody can see)', () => {
    const cfg = config();
    const out = html(
      renderSection(
        section('hero', 'split-image', { headline: 'Hi', image: { assetId: 'x', alt: 'Gym floor' } }),
        ctxFor(cfg),
        { registry, asH1: true, priority: true },
      ),
    );
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain('aria-label="Gym floor"');
    expect(out).not.toContain('role="img"');
  });
  it('speaks Hindi when the site language is hi', () => {
    const cfg = parsed(baseConfig([], { business: { ...baseConfig().business, language: 'hi' } }));
    const out = html(renderSection(contactSection, ctxFor(cfg), { registry, asH1: false, priority: false }));
    expect(out).toContain('मैप में खोलें');
    expect(out).toContain('सोम');
    expect(out).not.toContain('Open in Maps');
  });
});

describe('chrome', () => {
  it('header: skip link, labelled navigation, current page, safe targets only', () => {
    const cfg = parsed(
      baseConfig([], {
        navigation: {
          items: [
            { label: 'Home', target: '/' },
            { label: 'Elsewhere', target: 'https://example.com' },
          ],
          cta: { label: 'Call', action: 'tel' },
        },
      }),
    );
    const out = html(<Header ctx={ctxFor(cfg)} currentPath="/" />);
    expect(out).toContain('href="#main"');
    expect(out).toContain('aria-label="Main navigation"');
    expect(out).toContain('aria-current="page"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain('<details');
    expect(out).toContain('tel:+919800000000');
  });
  it('footer: contact, hours, social, and the platform badge only when provided', () => {
    const cfg = config();
    const none = html(<Footer ctx={ctxFor(cfg)} />);
    expect(none).toContain('Iron Pulse Fitness');
    expect(none).toContain('Mon, Tue: 05:30 to 22:00');
    expect(none).toContain('Instagram');
    const withBadge = html(
      <Footer
        ctx={ctxFor(cfg, {
          platformBadge: { label: 'Built with Platform', href: 'https://platform.example.test' },
        })}
      />,
    );
    expect(withBadge).toContain('Built with Platform');
    const hidden = parsed(
      baseConfig([], { footer: { variant: 'columns', showPlatformBadge: false, floatingAction: 'none' } }),
    );
    expect(
      html(
        <Footer
          ctx={ctxFor(hidden, {
            platformBadge: { label: 'Built with Platform', href: 'https://platform.example.test' },
          })}
        />,
      ),
    ).not.toContain('Built with Platform');
  });
  it('floating buttons: per setting, and only for numbers the business has', () => {
    const f = (floatingAction: 'none' | 'whatsapp' | 'call' | 'both', biz = {}) =>
      html(
        <FloatingActions
          ctx={ctxFor(
            parsed(
              baseConfig([], {
                footer: { variant: 'simple', showPlatformBadge: false, floatingAction },
                business: { ...baseConfig().business, ...biz },
              }),
            ),
          )}
        />,
      );
    expect(f('none')).toBe('');
    expect(f('whatsapp')).toContain('wa.me');
    expect(f('whatsapp')).not.toContain('tel:');
    expect(f('call')).toContain('tel:');
    expect(f('both')).toContain('wa.me');
    expect(f('both')).toContain('tel:');
    expect(f('both', { phone: '', whatsapp: '' })).toBe('');
  });
});

describe('logo', () => {
  const withLogo = () =>
    parsed(
      baseConfig([], {
        business: { ...baseConfig().business, logo: { assetId: 'logo-1', alt: 'Iron Pulse logo' } },
      }),
    );
  it('replaces the written name once the file exists, and falls back to the name until then', () => {
    const cfg = withLogo();
    const assetUrl = (id: string, w: number) => `https://assets.example.test/${id}-${w}.webp`;
    const shown = html(<Header ctx={ctxFor(cfg, { assetUrl })} currentPath="/" />);
    expect(shown).toContain('class="pb-logo"');
    expect(shown).toContain('src="https://assets.example.test/logo-1-400.webp"');
    expect(shown.toLowerCase()).toContain('alt="iron pulse logo"');
    const missing = html(<Header ctx={ctxFor(cfg)} currentPath="/" />);
    expect(missing).not.toContain('pb-logo');
    expect(missing).toContain('Iron Pulse Fitness</a>');
  });
});
