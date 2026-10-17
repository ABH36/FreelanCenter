# Platform (working name)

Multi-tenant, AI-assisted website delivery platform for freelancers and agencies serving local businesses.

**Current phase:** Phase 0 is **APPROVED WITH CONDITIONS** (Architect and auditor, 2026-09-21; see [docs/reports/PHASE_0_AUDIT.md](docs/reports/PHASE_0_AUDIT.md)). SRS v1.2.1 is frozen. The GitHub repository and CI exist; the live Supabase `ap-south-1` RLS/pooler proof and Vercel preview-deployment gate are verified (see [DG-02 evidence](docs/reports/PHASE_1_DG02_VERCEL_PREVIEW.md)). No product features exist yet.

| Read this                                                                                      | For                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [SRS.md](SRS.md)                                                                               | the requirements and approved plan (v1.2.1)              |
| [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)                                                     | byte-identical mirror of SRS.md (SRS section 0.3)        |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)                                     | the builder detailed plan, open questions (unaudited)    |
| [docs/reports/PHASE_0_REPORT.md](docs/reports/PHASE_0_REPORT.md)                               | what Phase 0 delivered, evidence, honest gaps            |
| [docs/PHASE_EXECUTION_LOG.md](docs/PHASE_EXECUTION_LOG.md)                                     | what was built, how it fits together, why                |
| [docs/adr/README.md](docs/adr/README.md)                                                       | architecture decisions and their verification status     |
| [docs/spikes/](docs/spikes)                                                                    | spike reports (A-E)                                      |
| [docs/traceability.md](docs/traceability.md)                                                   | generated requirement -> phase matrix                    |
| [docs/threat-model.md](docs/threat-model.md)                                                   | STRIDE threat model v1                                   |
| [docs/modules/README.md](docs/modules/README.md)                                               | module-by-module implementation contracts and AI handoff |
| [docs/README.md](docs/README.md)                                                               | documentation home, authority and reading order          |
| [docs/governance/DOCUMENTATION_INDEX.md](docs/governance/DOCUMENTATION_INDEX.md)               | canonical reading order and non-authoritative docs       |
| [docs/governance/DOCUMENTATION_GAP_REGISTER.md](docs/governance/DOCUMENTATION_GAP_REGISTER.md) | open evidence/decision gates and closure rules           |
| [docs/governance/CROSS_MODULE_CONTRACTS.md](docs/governance/CROSS_MODULE_CONTRACTS.md)         | mandatory shared contracts across all modules            |

## Layout

```
apps/dashboard   freelancer / creator / admin / client-portal UI   :3000
apps/sites       tenant site renderer + public APIs                :3001
packages/*       schema, db, blocks, ai, jobs, providers, ui, config (placeholders until their phase)
spikes/*         disposable experiments (not product code)
docs/            ADRs, reports, threat model, plan
```

## Commands

```bash
pnpm install && pnpm dev    # both apps
pnpm check                  # what CI runs
```

Spike B (needs Docker): `cd spikes/spike-b-rls-pooling && pnpm spike:up && pnpm spike:generate && pnpm spike:test`
