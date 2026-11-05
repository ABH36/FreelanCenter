import type { ManifestField } from '@platform/schema';
import type { SectionInput } from './helpers';

/**
 * A built-in template as authored. It is deliberately loose (plain data): `templateSchema` is the judge, and the tests
 * of this package run every template through it, through the contrast check, and through the real renderer.
 */
export interface TemplateDefinition {
  id: string;
  version: number;
  name: string;
  category: string;
  description: string;
  tags: string[];
  config: {
    schemaVersion: '1.0';
    business: Record<string, unknown>;
    theme: Record<string, unknown>;
    pages: { id: string; path: string; title: string; seo?: unknown; sections: SectionInput[] }[];
    navigation: { items: { label: string; target: string }[]; cta?: unknown };
    footer: Record<string, unknown>;
    integrations: Record<string, unknown>;
  };
  manifest: { fields: ManifestField[] };
}
