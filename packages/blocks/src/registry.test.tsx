import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type z } from 'zod';
import { BLOCKS, BLOCK_TYPES, parseSiteConfig } from '@platform/schema';
import { CHROME, createRegistry, getBlock, listBlocks, registry, type BlockDefinition } from './index';
import { allDefaultSections, baseConfig } from './test-helpers';

describe('registry consistency with the schema catalog (FR-TPL-02)', () => {
  it('has exactly the schema block types and variants, plus three chrome blocks (15 in all)', () => {
    expect(
      listBlocks()
        .map((d) => d.type)
        .sort(),
    ).toEqual([...BLOCK_TYPES].sort());
    for (const def of listBlocks()) {
      expect(def.variants.map((v) => v.id)).toEqual([...BLOCKS[def.type as keyof typeof BLOCKS].variants]);
    }
    expect(listBlocks().length + CHROME.length).toBe(15);
    expect(registry.chrome().map((c) => c.name)).toEqual(['header', 'footer', 'floating-action']);
  });

  it('publishes editor metadata for every prop, with the right required flag', () => {
    for (const def of listBlocks()) {
      const shape = (BLOCKS[def.type as keyof typeof BLOCKS].props as unknown as z.ZodObject).shape;
      const described = def.fields.map((f) => f.path).sort();
      expect(described, def.type).toEqual(Object.keys(shape).sort());
      for (const field of def.fields) {
        const schema = shape[field.path] as z.ZodType;
        expect(field.required === true, `${def.type}.${field.path}`).toBe(!schema.isOptional());
        expect(field.label.length).toBeGreaterThan(0);
        if (field.kind === 'list')
          expect(field.itemFields !== undefined || field.maxItems !== undefined).toBe(true);
      }
      expect(def.label.length + def.description.length).toBeGreaterThan(10);
    }
  });

  it('every variant has valid default content, and all defaults together form a valid config', () => {
    for (const def of listBlocks()) {
      for (const v of def.variants)
        expect(def.schema.safeParse(def.defaults(v.id)).success, `${def.type}/${v.id}`).toBe(true);
    }
    const r = parseSiteConfig(baseConfig(allDefaultSections()));
    expect(r.ok, JSON.stringify(!r.ok && r.issues)).toBe(true);
  });

  it('declares the page heading owner only on the hero', () => {
    expect(
      listBlocks()
        .filter((d) => d.providesH1)
        .map((d) => d.type),
    ).toEqual(['hero']);
  });
});

describe('registry lookup', () => {
  it('finds a block only for a real type and variant, never through the prototype chain', () => {
    expect(getBlock('hero', 'centered')?.type).toBe('hero');
    expect(getBlock('hero', 'nope')).toBeUndefined();
    expect(getBlock('nope', 'x')).toBeUndefined();
    for (const k of ['constructor', '__proto__', 'toString', 'hasOwnProperty'])
      expect(registry.get(k)).toBeUndefined();
  });
  it('refuses duplicate types and blocks without variants', () => {
    const hero = registry.get('hero') as BlockDefinition;
    expect(() => createRegistry([hero, hero])).toThrow(/Duplicate/);
    expect(() => createRegistry([{ ...hero, type: 'x', variants: [] }])).toThrow(/no variants/);
  });
});

describe('purity rules (blocks render on the server and are isolated by expansion)', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = (d: string): string[] =>
    readdirSync(d, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? files(join(d, e.name))
        : /\.(ts|tsx)$/.test(e.name) && !/\.test\.|test-helpers/.test(e.name)
          ? [join(d, e.name)]
          : [],
    );
  it('no hooks, no dangerouslySetInnerHTML, no inline style props, no env or network access in block code', () => {
    for (const f of files(dir).filter((p) => !p.endsWith('error-boundary.tsx'))) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(
        /\buse(State|Effect|Ref|Context|Memo|Callback|Reducer|Id|Transition|Optimistic)\b|\buse\(/,
      );
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML/);
      expect(src, f).not.toMatch(/\bstyle=\{/);
      expect(src, f).not.toMatch(/process\.env|\bfetch\(|XMLHttpRequest|localStorage|document\.|window\./);
    }
  });
  it('the renderer core never switches on a block name', () => {
    const src = readFileSync(join(dir, 'render.tsx'), 'utf8');
    for (const type of BLOCK_TYPES) expect(src).not.toContain(`'${type}'`);
  });
});
