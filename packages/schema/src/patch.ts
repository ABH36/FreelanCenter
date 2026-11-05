/**
 * `PatchOperation` (FR-TPL-01): the closed set of edits that AI, builder and onboarding may propose. A patch is an
 * untrusted proposal: `applyPatch` works on a copy and returns the result only if the *whole* config still validates
 * (AGENTS.md: AI output and client submissions are validated and explicitly applied, never trusted).
 */
import { z } from 'zod';
import { sectionSchema } from './blocks';
import { shortText, slug } from './primitives';
import { parseSiteConfig, type ConfigIssue } from './parse';
import { siteConfigSchema, type SiteConfig } from './site-config';
import { themeSchema } from './theme';

const sectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
const businessPatch = siteConfigSchema.shape.business.partial();
const themePatch = z.strictObject({
  colors: themeSchema.shape.colors.partial().optional(),
  typography: themeSchema.shape.typography.partial().optional(),
  radius: themeSchema.shape.radius.optional(),
  spacing: themeSchema.shape.spacing.optional(),
  buttons: themeSchema.shape.buttons.partial().optional(),
  motion: z.strictObject({ preset: themeSchema.shape.motion.shape.preset.optional() }).optional(),
});

export const patchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('updateBusiness'), value: businessPatch }),
  z.strictObject({ op: z.literal('updateTheme'), value: themePatch }),
  z.strictObject({
    op: z.literal('updatePage'),
    pageId: slug,
    title: shortText.min(1).optional(),
    seo: siteConfigSchema.shape.pages.element.shape.seo.optional(),
  }),
  z.strictObject({
    op: z.literal('updateSection'),
    sectionId,
    // Replacing `props` wholesale keeps the operation total: the result is validated against the block's schema.
    props: z.record(z.string(), z.unknown()).optional(),
    variant: z.string().max(40).optional(),
    visible: z.boolean().optional(),
  }),
  z.strictObject({
    op: z.literal('addSection'),
    pageId: slug,
    index: z.number().int().min(0).max(1000).optional(),
    section: sectionSchema,
  }),
  z.strictObject({ op: z.literal('removeSection'), sectionId }),
  z.strictObject({ op: z.literal('moveSection'), sectionId, toIndex: z.number().int().min(0).max(1000) }),
]);
export type PatchOperation = z.infer<typeof patchOperationSchema>;

/** A patch is a short list: bounded so a proposal cannot be used to amplify work. */
export const patchSchema = z.array(patchOperationSchema).min(1).max(50);

export type PatchResult =
  | { readonly ok: true; readonly config: SiteConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

const reject = (message: string, path = ''): PatchResult => ({ ok: false, issues: [{ path, message }] });

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge only plain objects; arrays and scalars replace. Prototype keys are never copied. */
function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = v === undefined ? out[k] : deepMerge(out[k], v);
  }
  return out;
}

function locate(config: SiteConfig, sectionIdValue: string) {
  for (const page of config.pages) {
    const index = page.sections.findIndex((s) => s.id === sectionIdValue);
    if (index >= 0) return { page, index };
  }
  return null;
}

export function applyPatch(current: SiteConfig, rawPatch: unknown): PatchResult {
  const parsedPatch = patchSchema.safeParse(rawPatch);
  if (!parsedPatch.success) {
    return {
      ok: false,
      issues: parsedPatch.error.issues
        .slice(0, 25)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  }
  const draft = structuredClone(current);

  for (const [n, op] of parsedPatch.data.entries()) {
    const at = `patch.${n}`;
    switch (op.op) {
      case 'updateBusiness':
        draft.business = deepMerge(draft.business, op.value) as SiteConfig['business'];
        break;
      case 'updateTheme':
        draft.theme = deepMerge(draft.theme, op.value) as SiteConfig['theme'];
        break;
      case 'updatePage': {
        const page = draft.pages.find((p) => p.id === op.pageId);
        if (!page) return reject('Unknown page', at);
        if (op.title !== undefined) page.title = op.title;
        if (op.seo !== undefined) page.seo = { ...page.seo, ...op.seo };
        break;
      }
      case 'updateSection': {
        const found = locate(draft, op.sectionId);
        if (!found) return reject('Unknown section', at);
        const section = found.page.sections[found.index] as Record<string, unknown>;
        if (op.props !== undefined) section['props'] = op.props;
        if (op.variant !== undefined) section['variant'] = op.variant;
        if (op.visible !== undefined) section['visible'] = op.visible;
        break;
      }
      case 'addSection': {
        const page = draft.pages.find((p) => p.id === op.pageId);
        if (!page) return reject('Unknown page', at);
        page.sections.splice(Math.min(op.index ?? page.sections.length, page.sections.length), 0, op.section);
        break;
      }
      case 'removeSection': {
        const found = locate(draft, op.sectionId);
        if (!found) return reject('Unknown section', at);
        found.page.sections.splice(found.index, 1);
        break;
      }
      case 'moveSection': {
        const found = locate(draft, op.sectionId);
        if (!found) return reject('Unknown section', at);
        const [moved] = found.page.sections.splice(found.index, 1);
        if (moved) found.page.sections.splice(Math.min(op.toIndex, found.page.sections.length), 0, moved);
        break;
      }
    }
  }

  // The proposal only becomes a config if the entire document is still valid (size, uniqueness, catalog, URLs).
  const result = parseSiteConfig(draft);
  return result.ok ? { ok: true, config: result.config } : result;
}
