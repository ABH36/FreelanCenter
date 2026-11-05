/**
 * @platform/blocks
 * Block registry, the 15 blocks (12 sections plus header, footer and floating actions), and isolated section
 * rendering (pure layer: no I/O, no hooks). Styles: `@platform/blocks/blocks.css`.
 */
export const PACKAGE_NAME = '@platform/blocks' as const;

export * from './context';
export * from './cta';
export * from './document';
export * from './seo';
export { serialize } from './serialize';
export * from './chrome';
export * from './error-boundary';
export { Icon, ICON_NAMES } from './icons';
export * from './registry';
export * from './render';
export * from './strings';
export * from './types';
