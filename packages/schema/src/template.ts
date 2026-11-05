/**
 * `Template` (FR-TPL-01, FR-TPL-08, FR-TPL-11, ADR-004): a template is data. It carries a full default SiteConfig plus
 * an onboarding manifest (the fields a client must supply, each mapped to a config path). A template package is an
 * untrusted proposal: it is validated here before it can be stored or applied.
 *
 * The manifest drives the client wizard (FR-ONB-02): simple values (name, phone, address ...), a photo, the opening
 * hours, and repeating groups such as services with prices or testimonials. Every path must already exist in the
 * default config, so applying an answer can only fill a place the template defined, never create one.
 */
import { z } from 'zod';
import { CATEGORIES, siteConfigSchema, type SiteConfig } from './site-config';
import { longText, requiredShortText, shortText, slug } from './primitives';

export const SCALAR_KINDS = ['text', 'longtext', 'phone', 'email', 'url'] as const;
export const MANIFEST_FIELD_KINDS = [...SCALAR_KINDS, 'image', 'hours', 'images', 'list'] as const;
export type ManifestKind = (typeof MANIFEST_FIELD_KINDS)[number];

const configPath = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*(\.([A-Za-z][A-Za-z0-9]*|\d{1,3}))*$/,
    'Use dot notation such as business.name',
  );

const propertyName = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/);

/** One column of a repeating group (for example a service's name, description and price). */
export const manifestItemFieldSchema = z.strictObject({
  key: propertyName,
  label: requiredShortText,
  kind: z.enum(['text', 'longtext']),
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(3000).optional(),
});

export const manifestFieldSchema = z.strictObject({
  key: slug,
  label: requiredShortText,
  help: shortText.optional(),
  kind: z.enum(MANIFEST_FIELD_KINDS),
  path: configPath,
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(3000).optional(),
  /** `list` and `images`: how many entries the client may supply (never more than the config allows). */
  maxItems: z.number().int().min(1).max(24).optional(),
  /** `list` only. */
  itemFields: z.array(manifestItemFieldSchema).min(1).max(6).optional(),
});
export type ManifestField = z.infer<typeof manifestFieldSchema>;

/** Walk a dot path through a config. Own properties only. */
export function getAtPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    if (Array.isArray(node) ? !/^\d{1,3}$/.test(segment) : !Object.hasOwn(node, segment)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Does the value found in the default config have the shape this kind of field fills? */
function fits(field: ManifestField, value: unknown): string | null {
  switch (field.kind) {
    case 'text':
    case 'longtext':
    case 'phone':
    case 'email':
    case 'url':
      return typeof value === 'string' ? null : 'expected a text value';
    case 'image':
      return isRecord(value) && typeof value['assetId'] === 'string' ? null : 'expected an image';
    case 'hours':
      return Array.isArray(value) ? null : 'expected the opening-hours list';
    case 'images':
      return Array.isArray(value) && value.every((v) => isRecord(v) && typeof v['assetId'] === 'string')
        ? null
        : 'expected a list of images';
    case 'list': {
      if (!Array.isArray(value)) return 'expected a list';
      if (!field.itemFields) return 'a list field needs itemFields';
      const first = value[0];
      if (first !== undefined) {
        if (!isRecord(first)) return 'list items must be objects';
        for (const col of field.itemFields) {
          if (!Object.hasOwn(first, col.key)) return `list items have no "${col.key}"`;
        }
      }
      return null;
    }
  }
}

export const templateSchema = z
  .strictObject({
    id: slug,
    version: z.number().int().min(1).max(10_000),
    name: requiredShortText,
    category: z.enum(CATEGORIES),
    description: longText.max(300),
    tags: z.array(slug).max(8),
    config: siteConfigSchema,
    manifest: z.strictObject({ fields: z.array(manifestFieldSchema).min(1).max(60) }),
  })
  .superRefine((tpl, ctx) => {
    if (tpl.config.business.category !== tpl.category) {
      ctx.addIssue({
        code: 'custom',
        path: ['config', 'business', 'category'],
        message: 'Config category differs from template category',
      });
    }
    const keys = new Set<string>();
    const paths = new Set<string>();
    tpl.manifest.fields.forEach((field, i) => {
      const at = (key: string) => ['manifest', 'fields', i, key];
      if (keys.has(field.key)) {
        ctx.addIssue({ code: 'custom', path: at('key'), message: 'Duplicate manifest key' });
      }
      keys.add(field.key);
      if (paths.has(field.path)) {
        ctx.addIssue({ code: 'custom', path: at('path'), message: 'Two manifest fields fill the same path' });
      }
      paths.add(field.path);
      if (field.kind !== 'list' && field.itemFields) {
        ctx.addIssue({ code: 'custom', path: at('itemFields'), message: 'Only list fields have itemFields' });
      }
      if (field.kind !== 'list' && field.kind !== 'images' && field.maxItems !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: at('maxItems'),
          message: 'maxItems applies to list and images',
        });
      }
      const value = getAtPath(tpl.config, field.path);
      const problem = value === undefined ? 'Path does not exist in the config' : fits(field, value);
      if (problem) ctx.addIssue({ code: 'custom', path: at('path'), message: problem });
    });
  });

export type Template = z.infer<typeof templateSchema>;
export type TemplateConfig = SiteConfig;
