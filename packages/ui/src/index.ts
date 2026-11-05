/**
 * @platform/ui
 * Shared design system (pure layer): tokens, the theme compiler, font policy and animation presets.
 * Component primitives land with the blocks (P2 S3); base tokens live in tokens.css.
 */
export const PACKAGE_NAME = '@platform/ui' as const;

export * from './color';
export * from './fonts';
export * from './motion';
export * from './theme';
