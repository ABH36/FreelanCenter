/**
 * @platform/schema
 * SiteConfig v1.0, Template, patch operations and the block catalog (pure layer, no I/O).
 * Read configs only through `parseSiteConfig`; apply proposals only through `applyPatch`.
 */
export const PACKAGE_NAME = '@platform/schema' as const;

export * from './primitives';
export * from './theme';
export * from './blocks';
export * from './site-config';
export * from './migrate';
export * from './parse';
export * from './patch';
export * from './template';
export { buildJsonSchemas } from './json-schema';
