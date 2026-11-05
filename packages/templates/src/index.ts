/**
 * @platform/templates
 * The built-in reference templates (FR-TPL-10): Gym, Taxi, Wedding/Event. Each is a `Template` as defined by
 * `@platform/schema` (default SiteConfig plus onboarding manifest) and nothing else: no code, no assets. The tests of
 * this package validate every template with `templateSchema`, the contrast check and the real renderer.
 */
import { gym } from './gym';
import { taxi } from './taxi';
import { wedding } from './wedding';
import type { TemplateDefinition } from './types';

export const PACKAGE_NAME = '@platform/templates' as const;

export type { TemplateDefinition } from './types';
export const BUILT_IN_TEMPLATES: readonly TemplateDefinition[] = [gym, taxi, wedding];

export function getBuiltInTemplate(id: string): TemplateDefinition | undefined {
  return BUILT_IN_TEMPLATES.find((t) => t.id === id);
}
