# Documentation Index and Reading Protocol

## Purpose

This is the authoritative entry point for people and AI agents. It prevents duplicated planning documents, false implementation claims and unnecessary token use.

## Truth hierarchy

| Rank | Source                                          | Use                                                                     | Read rule                                                                       |
| ---- | ----------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1    | `SRS.md`                                        | Frozen product requirements and acceptance scope                        | Read the relevant section before any feature work.                              |
| 2    | `docs/adr/*.md`                                 | Approved/proposed architecture decisions and their verification status  | Read ADRs referenced by the requirement/module. Proposed is not verified.       |
| 3    | `docs/modules/*.md`                             | Module implementation contracts, dependencies and evidence expectations | Read the target module and upstream contracts.                                  |
| 4    | `docs/governance/CROSS_MODULE_CONTRACTS.md`     | Shared invariants, actor boundaries, state/event rules                  | Read for work that crosses a module boundary.                                   |
| 5    | `docs/governance/DOCUMENTATION_GAP_REGISTER.md` | Known evidence/decision gaps and phase gates                            | Check before starting a phase or vendor-dependent work.                         |
| 6    | `docs/spikes/*.md`                              | Measured/researched vendor evidence                                     | Read only the spike relevant to the current vendor/decision.                    |
| 7    | Reports, execution log, traceability            | Historical evidence, audit and release context                          | Read for audits, phase gates and requirement proof; not routine feature design. |

If two documents conflict, stop and follow the higher-ranked source; raise an ADR/question rather than choosing silently.

## Task-specific reading matrix

| Work                       | Minimum reading set                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| P1 auth/workspace/db       | SRS §5.1/5.3/6.1–6.3; modules 01–03; ADR-003/006/007; Spike B; gap register; environment policy                |
| Template/renderer          | SRS §5.2/6.4; module 04; ADR-004/009; security module                                                          |
| Builder/publish            | SRS §6.5–6.6; modules 05–06; contracts; module 15                                                              |
| AI                         | SRS §8/6.7; module 07; ADR-008; Spike C; modules 03/15/16                                                      |
| Onboarding/leads           | SRS §6.8–6.9; modules 08–09; contracts; privacy inventory                                                      |
| Marketplace/billing        | SRS §6.10–6.11; modules 10–11; ADR-011; payment spike; module 15                                               |
| Domains/white-label/export | SRS §6.12–6.14; modules 12–13; ADR-005/009/012; relevant spike                                                 |
| Launch/hardening           | SRS §9–11; modules 14–16; environment policy; threat model; privacy/data classification; phase report template |

## Deliberately non-authoritative material

`docs/enterprise-enhancements/` is an **untracked exploratory proposal set**. Its “existing/current state” language conflicts with the real repository, which has Phase-0 scaffolds and no product features. Do not use it to implement, estimate, prioritize or claim functionality. It is retained unchanged for human review only. A future Owner-approved ADR may either reconcile selected ideas into post-v1 requirements or archive/delete the folder.

`DEVELOPMENT_PLAN.md` is required by the SRS but duplicates `SRS.md`; read `SRS.md` only. Phase reports and `PHASE_EXECUTION_LOG.md` are audit history, not design authority. Read one only when its evidence is directly needed.

## Required handoff record

Every implementation PR/agent handoff includes:

1. SRS IDs addressed and explicitly excluded.
2. Files/contracts/ADRs read and changed.
3. Authorization, RLS, privacy, abuse and failure-path review.
4. API/schema/event compatibility and migration/rollback statement.
5. Tests run, results and unrun evidence.
6. Metrics/logs/audit events added or intentionally deferred.
7. Open decisions or proposed ADRs.

## Documentation lifecycle

Planned → implemented → verified is an evidence progression. “Implemented” requires code plus automated tests. “Verified” additionally requires phase evidence/audit approval. Generated artefacts (`DEVELOPMENT_PLAN.md`, traceability) must be regenerated through their scripts, never hand-edited.
