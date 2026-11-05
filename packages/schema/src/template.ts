/**
 * `Template` (FR-TPL-01, FR-TPL-08, FR-TPL-11, ADR-004): a template is data. It carries a full default SiteConfig plus
 * an onboarding manifest (the fields a client must supply, each mapped to a config path). A template package is an
 * untrusted proposal: it is validated here before it can be stored or applied.
 */
import { z } from 'zod';
import { CATEGORIES, siteConfigSchema, type SiteConfig } from './site-config';
import { longText, requiredShortText, shortText, slug } from './primitives';

export const MANIFEST_FIELD_KINDS = ['text', 'longtext', 'phone', 'email', 'url', 'image'] as const;

const configPath = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z][A-Za-z0-9]*(\.([A-Za-z][A-Za-z0-9]*|\d{1,3}))*$/,
    'Use dot notation such as business.name',
  );

export const manifestFieldSchema = z.strictObject({
  key: slug,
  label: requiredShortText,
  help: shortText.optional(),
  kind: z.enum(MANIFEST_FIELD_KINDS),
  path: configPath,
  required: z.boolean(),
  maxLength: z.number().int().min(1).max(3000).optional(),
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
    tpl.manifest.fields.forEach((field, i) => {
      if (keys.has(field.key))
        ctx.addIssue({
          code: 'custom',
          path: ['manifest', 'fields', i, 'key'],
          message: 'Duplicate manifest key',
        });
      keys.add(field.key);
      const value = getAtPath(tpl.config, field.path);
      // Every field must point at something that exists in the default config, so applying an answer can never
      // create a path; text-like kinds must point at a string.
      if (value === undefined || (field.kind !== 'image' && typeof value !== 'string')) {
        ctx.addIssue({
          code: 'custom',
          path: ['manifest', 'fields', i, 'path'],
          message: 'Path does not resolve to a value of this kind in the config',
        });
      }
    });
  });

export type Template = z.infer<typeof templateSchema>;
export type TemplateConfig = SiteConfig;
