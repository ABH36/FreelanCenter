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

// ADR-007 rule 3 (Spike G G-4): only packages/jobs talks to Inngest; everything else uses its typed emitters.
const NO_INNGEST = [
  ['inngest', 'inngest/*'],
  'ADR-007: import job helpers from @platform/jobs; only packages/jobs imports the Inngest SDK.',
];

const NO_INNER_HTML = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message: 'SEC-04: dangerouslySetInnerHTML is forbidden. Render tenant content as data.',
};
// A job scope has workspace context without an actor; only the job handlers (and tests) may open one.
const NO_JOB_SCOPE = {
  selector: "MemberExpression[property.name='withJobTenant']",
  message:
    'withJobTenant is for background job handlers only (packages/workspaces/src/delivery.ts, notification-delivery.ts, outbox.ts).',
};
// No context at all; only the outbox sweep may open one (it reads nothing but app.outbox_pending()).
const NO_SYSTEM_SCOPE = {
  selector: "MemberExpression[property.name='withSystem']",
  message: 'withSystem is for the outbox sweep only (packages/workspaces/src/outbox.ts).',
};

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
      'no-restricted-syntax': ['error', NO_INNER_HTML, NO_JOB_SCOPE, NO_SYSTEM_SCOPE],
    },
  },
  {
    // Layering: packages never depend on apps.
    files: ['packages/**/*.{ts,tsx}'],
    rules: restrict(NO_APPS, NO_INNGEST),
  },
  {
    files: ['packages/jobs/**/*.{ts,tsx}'],
    rules: restrict(NO_APPS),
  },
  {
    // The job handlers may open a job scope.
    files: ['packages/workspaces/src/delivery.ts', 'packages/workspaces/src/notification-delivery.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_INNER_HTML, NO_SYSTEM_SCOPE] },
  },
  {
    // The outbox (dispatch in a job scope, sweep with no context), the data layer and test suites.
    files: ['packages/workspaces/src/outbox.ts', 'packages/db/**/*.ts', '**/test/**/*.ts', 'tests/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_INNER_HTML] },
  },
  {
    // Pure layers: schema, blocks and ui must stay free of I/O packages (and still may not import apps).
    files: ['packages/schema/**/*.{ts,tsx}', 'packages/blocks/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    rules: restrict(
      NO_APPS,
      [
        ['@platform/db', '@platform/jobs', '@platform/ai', '@platform/providers', '@prisma/*'],
        'schema/blocks/ui are pure layers: no database, jobs, AI or provider imports.',
      ],
      NO_INNGEST,
    ),
  },
  {
    // The two apps must never import each other (ADR-002: separate trust domains).
    files: ['apps/sites/**/*.{ts,tsx}'],
    rules: restrict(
      [
        ['**/apps/dashboard/**', '@platform/dashboard', '@platform/auth'],
        'ADR-002: sites must not import dashboard code or dashboard auth (no shared sessions or cookies).',
      ],
      NO_INNGEST,
    ),
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    rules: restrict(
      [['**/apps/sites/**', '@platform/sites'], 'ADR-002: dashboard must not import sites code.'],
      NO_INNGEST,
    ),
  },
  {
    // Node scripts, configs and spikes may print to the console.
    files: ['**/*.mjs', '**/*.js', 'scripts/**', 'spikes/**'],
    rules: { 'no-console': 'off' },
  },
);
