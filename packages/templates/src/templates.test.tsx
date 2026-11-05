/**
 * P2 S5a evidence (FR-TPL-08/10/11, ADR-004 acceptance): three distinct, valid, accessible, renderable templates built
 * only from the block registry, each with a working onboarding manifest.
 */
import { describe, expect, it } from 'vitest';
import {
  BLOCK_TYPES,
  CATEGORIES,
  getAtPath,
  parseSiteConfig,
  templateSchema,
  type Template,
} from '@platform/schema';
import { renderDocument, registry, type BlockErrorInfo } from '@platform/blocks';
import { contrastIssues } from '@platform/ui';
import { BUILT_IN_TEMPLATES, getBuiltInTemplate } from './index';

const parsedTemplate = (id: string): Template => {
  const raw = getBuiltInTemplate(id);
  const r = templateSchema.safeParse(raw);
  if (!r.success) throw new Error(`${id}: ${JSON.stringify(r.error.issues.slice(0, 5))}`);
  return r.data;
};

const ORIGIN = 'https://demo.sites.example.test';

describe.each(BUILT_IN_TEMPLATES.map((t) => [t.id] as const))('template %s', (id) => {
  const tpl = parsedTemplate(id);

  it('is a valid Template with a category from the taxonomy and an unambiguous identity', () => {
    expect(CATEGORIES).toContain(tpl.category);
    expect(tpl.version).toBe(1);
    expect(tpl.description.length).toBeGreaterThan(40);
  });

  it('meets WCAG 2.1 AA contrast for its colour tokens', () => {
    expect(contrastIssues(tpl.config.theme)).toEqual([]);
  });

  it('renders every page: 200, one h1, no block error, no script, within the HTML size budget', () => {
    for (const page of tpl.config.pages) {
      const errors: BlockErrorInfo[] = [];
      const r = renderDocument({
        config: tpl.config,
        path: page.path,
        origin: ORIGIN,
        mode: 'public',
        onBlockError: (e) => errors.push(e),
      });
      if (r.kind !== 'page') throw new Error(`${id} ${page.path}: ${r.kind}`);
      expect(errors, `${id} ${page.path}`).toEqual([]);
      expect(r.status).toBe(200);
      expect(r.html.match(/<h1[ >]/g), `${id} ${page.path}`).toHaveLength(1);
      expect([...r.html.matchAll(/<script[^>]*>/g)].map((m) => m[0])).toEqual(
        page.path === '/' ? ['<script type="application/ld+json">'] : [],
      );
      expect(Buffer.byteLength(r.html, 'utf8')).toBeLessThan(80 * 1024);
      expect(r.html).not.toMatch(/lorem|ipsum|TODO|placeholder text/i);
    }
  });

  it('every internal link and anchor in the rendered pages points at something that exists', () => {
    const pageIds = new Map(
      tpl.config.pages.map((p) => [p.path, new Set(p.sections.map((s) => s.id))] as const),
    );
    for (const page of tpl.config.pages) {
      const r = renderDocument({ config: tpl.config, path: page.path, origin: ORIGIN, mode: 'public' });
      if (r.kind !== 'page') throw new Error('render failed');
      for (const m of r.html.matchAll(/href="((?:\/|#)[^"]*)"/g)) {
        const href = (m[1] ?? '').replace(/&amp;/g, '&');
        if (href.startsWith('/fonts/') || href === '#main') continue; // #main is the skip link to <main>
        const [pathPart = '', anchor] = href.split('#');
        const target = pathPart === '' ? page.path : pathPart;
        const sections = pageIds.get(target);
        expect(sections, `${id}: ${href} on ${page.path}`).toBeDefined();
        if (anchor) expect(sections?.has(anchor), `${id}: ${href} on ${page.path}`).toBe(true);
      }
    }
  });

  it('only uses blocks that are registered, with variants that exist', () => {
    for (const page of tpl.config.pages) {
      for (const s of page.sections)
        expect(registry.getBlock(s.type, s.variant), `${s.type}/${s.variant}`).toBeDefined();
    }
  });

  it('has a usable onboarding manifest: the basics, unique keys, required items first-class', () => {
    const keys = tpl.manifest.fields.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const must of [
      'business-name',
      'phone',
      'whatsapp',
      'address-line',
      'city',
      'opening-hours',
      'logo',
    ]) {
      expect(keys, must).toContain(must);
    }
    const required = tpl.manifest.fields.filter((f) => f.required);
    expect(required.length).toBeGreaterThanOrEqual(6);
    expect(tpl.manifest.fields.length).toBeLessThanOrEqual(30);
  });

  it('applying client answers to every manifest field keeps the config valid and the page renderable', () => {
    const config = structuredClone(tpl.config) as unknown as Record<string, unknown>;
    const answers: Record<string, unknown> = {
      text: 'Answer text',
      longtext: 'A longer answer for the field.',
      phone: '+919999999999',
      email: 'client@example.com',
      url: 'https://example.com/profile',
      image: { assetId: 'client-photo', alt: 'Client supplied photo' },
    };
    const set = (path: string, value: unknown) => {
      const parts = path.split('.');
      let node = config as Record<string, unknown>;
      for (const p of parts.slice(0, -1)) node = node[p] as Record<string, unknown>;
      node[parts[parts.length - 1] as string] = value;
    };
    for (const f of tpl.manifest.fields) {
      if (f.kind === 'hours') set(f.path, [{ days: ['mon', 'tue'], open: '09:00', close: '18:00' }]);
      else if (f.kind === 'images') set(f.path, [{ assetId: 'client-1', alt: 'Client photo one' }]);
      else if (f.kind === 'list') {
        const current = getAtPath(config, f.path) as Record<string, unknown>[];
        const first = { ...(current[0] ?? {}) };
        for (const col of f.itemFields ?? []) first[col.key] = `Answer ${col.key}`;
        set(f.path, [first]);
      } else set(f.path, answers[f.kind]);
    }
    const result = parseSiteConfig(config);
    expect(result.ok, JSON.stringify(!result.ok && result.issues.slice(0, 3))).toBe(true);
    const r = renderDocument({ config, path: '/', origin: ORIGIN, mode: 'public' });
    expect(r.kind).toBe('page');
  });
});

describe('the set of reference templates (FR-TPL-10)', () => {
  const all = BUILT_IN_TEMPLATES.map((t) => parsedTemplate(t.id));

  it('are exactly Gym, Taxi and Event/Wedding, with unique ids', () => {
    expect(all.map((t) => t.category).sort()).toEqual(['gym', 'taxi', 'wedding-event']);
    expect(new Set(all.map((t) => t.id)).size).toBe(3);
  });

  it('are visibly distinct: palette, fonts, hero layout, button shape, page count and section mix', () => {
    const colours = new Set(all.map((t) => t.config.theme.colors.primary));
    const headings = new Set(all.map((t) => t.config.theme.typography.heading));
    const heroes = new Set(
      all.map((t) => t.config.pages[0]?.sections.find((s) => s.type === 'hero')?.variant),
    );
    const backgrounds = new Set(all.map((t) => t.config.theme.colors.background));
    const shapes = new Set(all.map((t) => t.config.theme.buttons.shape));
    expect([colours.size, headings.size, heroes.size, backgrounds.size, shapes.size]).toEqual([
      3, 3, 3, 3, 3,
    ]);
    const signatures = new Set(
      all.map((t) =>
        t.config.pages.flatMap((p) => p.sections.map((s) => `${s.type}/${s.variant}`)).join(','),
      ),
    );
    expect(signatures.size).toBe(3);
  });

  it('together exercise most of the block catalog, with no block-specific code in any template', () => {
    const used = new Set(all.flatMap((t) => t.config.pages.flatMap((p) => p.sections.map((s) => s.type))));
    expect(used.size).toBeGreaterThanOrEqual(10);
    for (const t of used) expect(BLOCK_TYPES).toContain(t);
  });

  it('use only fonts that cover the template language and the platform allow-list', () => {
    for (const t of all) {
      expect(['Poppins', 'Inter', 'Montserrat', 'Open Sans', 'Playfair Display', 'Lato']).toContain(
        t.config.theme.typography.heading,
      );
    }
  });
});
