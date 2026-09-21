# ADR-001: Monorepo, pnpm + Turborepo, strict TypeScript, pinned toolchain

**Status:** Accepted (verified) · **Date:** 2026-09-21 · **SRS:** 4.4, 11.2, NFR-MAINT-01, NFR-OPS-01, SEC-13

## Context

Two Next.js apps and seven internal packages share types (Zod schemas, block registry, DB client). They must evolve together, be type-checked together, and be reproducible from a clean checkout.

## Decision

- **pnpm workspaces + Turborepo** (`apps/*`, `packages/*`, `spikes/*`). Internal packages are consumed as TypeScript source (`exports: ./src/index.ts`) and transpiled by the apps; no per-package build step.
- **Pinned versions (verified installing and running on 2026-09-21):** Node >= 22 (dev machine 24.18), pnpm 11.20, Turborepo 2.11.2, Next 16.3.5, React 19.3, TypeScript **5.9.3**, ESLint 10 (flat config) + typescript-eslint 8.70, Vitest 5, Prettier 3.9, Tailwind 4.3.
- **TypeScript 5.9, not 6 or 7:** typescript-eslint 8.70 declares support for `<6.1.0`, and 7.x (native compiler) is too new for the linting/Next ecosystem. Revisit when typescript-eslint supports it.
- **Strict everywhere** (`strict`, `noUncheckedIndexedAccess`, `noUnusedLocals`, ...). `no-explicit-any` is an error.
- **Architecture guardrails as lint rules:** packages may not import apps; schema/blocks/ui are pure (no db/jobs/ai/providers/prisma); the two apps may not import each other (ADR-002); `dangerouslySetInnerHTML` is forbidden (SEC-04).
- **Supply chain:** pnpm 11 denies dependency install scripts by default; `pnpm-workspace.yaml` `allowBuilds` lists the only two reviewed exceptions (`prisma`, `@prisma/engines`). Lockfile is committed and passes pnpm's supply-chain policy check.

## Consequences

- One command (`pnpm check`) runs format, lint, typecheck, tests and both production builds.
- Boundaries are enforced mechanically, not by review.

* pnpm 11 and Turborepo 2.11 are recent; expect occasional tool churn. Pinned exactly to limit it.

## Evidence

`pnpm typecheck` 9/9, `pnpm lint` 9/9, `pnpm test` 9/9, `pnpm build` 2/2, `pnpm dev` serves both apps (health 200, security headers present). Lint guardrails proven with 5 deliberate violations that were all caught. Two lint-config bugs were found and fixed during verification (helper shape; overlapping `no-restricted-imports` blocks replace, not merge).

## Revisit when

typescript-eslint supports TS >= 6.1; Next/Turbopack changes the workspace-root behaviour.
