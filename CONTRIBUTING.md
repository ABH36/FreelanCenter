# Contributing

## Working agreement

1. One phase at a time. Code only for the active phase (see `docs/IMPLEMENTATION_PLAN.md`). Do not bleed features forward.
2. Every commit and PR references requirement IDs from `SRS.md` (`FR-*`, `NFR-*`, `SEC-*`).
3. A decision that departs from the SRS needs an ADR in `docs/adr/` approved by the Owner.
4. Claims need evidence: test output, numbers, commit hashes. "Should work" is not evidence.
5. After each phase: `docs/reports/PHASE_N_REPORT.md` and an entry in `docs/PHASE_EXECUTION_LOG.md`. No next phase without an explicit APPROVED.

## Local setup

```bash
pnpm install         # Node >= 22, pnpm 11 (see .nvmrc / packageManager)
pnpm dev             # dashboard :3000, sites :3001
pnpm check           # format, lint, typecheck, test, build (what CI runs)
pnpm traceability    # regenerate docs/traceability.md after SRS changes
```

## Rules that are enforced mechanically

- ESLint: no `any`, no `dangerouslySetInnerHTML`, packages never import apps, `schema`/`blocks`/`ui` stay pure, the two apps never import each other.
- pnpm: dependency install scripts are denied unless listed in `allowBuilds` with a reason.
- Husky pre-commit formats staged files.

## Spikes

`spikes/*` are disposable experiments, not product code. They must not be imported by `apps/` or `packages/`. Each has a report in `docs/spikes/` that states plainly what was and was not measured.
