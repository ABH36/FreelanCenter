/**
 * JSON Schema export for docs and tools (FR-TPL-01). Generated from the Zod schemas, so it cannot drift from them;
 * `json-schema.test.ts` compares the committed files in `json-schema/` against this output.
 * Refinements (uniqueness, catalog membership, URL scheme checks) are not expressible in JSON Schema: the Zod
 * schemas remain the authority, and `parseSiteConfig` is the only supported way to validate.
 */
import { z } from 'zod';
import { BLOCKS } from './blocks';
import { patchSchema } from './patch';
import { siteConfigSchema } from './site-config';
import { templateSchema } from './template';

const options = { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' } as const;

export function buildJsonSchemas(): Record<string, unknown> {
  return {
    'site-config.schema.json': z.toJSONSchema(siteConfigSchema, options),
    'template.schema.json': z.toJSONSchema(templateSchema, options),
    'patch.schema.json': z.toJSONSchema(patchSchema, options),
  };
}

/**
 * P3 S3: the JSON Schemas the editor's forms are generated from (input shape): the business details and the props of
 * every block type. Forms only shape the input; every save is still validated by `applyPatch` with the Zod schemas.
 */
export function editorFormSchemas(): {
  business: Record<string, unknown>;
  blocks: Record<string, Record<string, unknown>>;
} {
  return {
    business: z.toJSONSchema(siteConfigSchema.shape.business, options) as Record<string, unknown>,
    blocks: Object.fromEntries(
      Object.entries(BLOCKS).map(([type, block]) => [
        type,
        z.toJSONSchema(block.props, options) as Record<string, unknown>,
      ]),
    ),
  };
}
