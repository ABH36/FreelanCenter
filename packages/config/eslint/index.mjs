// Shared ESLint flat config for the whole monorepo.
// Rules here encode architecture guardrails from the SRS (Section 4.4 layering, SEC-04).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Import-boundary helper. NOTE: in flat config a later block REPLACES an earlier
 * `no-restricted-imports` for the same file, it does not merge. So every block passes the
 * complete list of rules that apply to its files (see the pure-layer block below).
 */
const restrict = (...rules) => ({
  'no-restricted-imports': ['error', { patterns: rules.map(([group, message]) => ({ group, message })) }],
});

const NO_APPS = [
  ['**/apps/**', '@platform/dashboard', '@platform/sites'],
  'packages must not import from apps (SRS 4.4).',
];

export const platformConfig = tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/.next/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // SEC-04: tenant-supplied content is rendered as data, never as markup.
      'no-restricted-syntax': [
        'error',
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'SEC-04: dangerouslySetInnerHTML is forbidden. Render tenant content as data.',
        },
      ],
    },
  },
  {
    // Layering: packages never depend on apps.
    files: ['packages/**/*.{ts,tsx}'],
    rules: restrict(NO_APPS),
  },
  {
    // Pure layers: schema, blocks and ui must stay free of I/O packages (and still may not import apps).
    files: ['packages/schema/**/*.{ts,tsx}', 'packages/blocks/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: restrict(NO_APPS, [
      ['@platform/db', '@platform/jobs', '@platform/ai', '@platform/providers', '@prisma/*'],
      'schema/blocks/ui are pure layers: no database, jobs, AI or provider imports.',
    ]),
  },
  {
    // The two apps must never import each other (ADR-002: separate trust domains).
    files: ['apps/sites/**/*.{ts,tsx}'],
    rules: restrict([
      ['**/apps/dashboard/**', '@platform/dashboard'],
      'ADR-002: sites must not import dashboard code.',
    ]),
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    rules: restrict([
      ['**/apps/sites/**', '@platform/sites'],
      'ADR-002: dashboard must not import sites code.',
    ]),
  },
  {
    // Node scripts, configs and spikes may print to the console.
    files: ['**/*.mjs', '**/*.js', 'scripts/**', 'spikes/**'],
    rules: { 'no-console': 'off' },
  },
);
