# Documentation Home

## Start here

For any implementation or planning task, read [Governance / Documentation Index](governance/DOCUMENTATION_INDEX.md) first. It gives the minimum reading set for each type of work and prevents agents from consuming non-authoritative material.

## Directory structure

| Folder / file                                                       | Purpose                                                                                             | Authority                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `../SRS.md`                                                         | Frozen product requirements and phase roadmap                                                       | Highest product authority            |
| `../AGENTS.md`                                                      | Mandatory agent/contributor execution rules                                                         | Mandatory operating rules            |
| [governance/](governance/README.md)                                 | Documentation authority, cross-module contracts, evidence gaps, Owner inputs and environment policy | Mandatory before planning/phase work |
| [modules/](modules/README.md)                                       | Module-by-module implementation contracts                                                           | Mandatory for target module work     |
| [adr/](adr/README.md)                                               | Architecture decisions and verification status                                                      | Mandatory when referenced            |
| [spikes/](spikes/)                                                  | Vendor/technical evidence                                                                           | Read only when relevant              |
| [reports/](reports/)                                                | Phase audit evidence                                                                                | Audit/phase-gate context             |
| `IMPLEMENTATION_PLAN.md`                                            | Builder task plan and resolved/open questions                                                       | Supporting planning source           |
| `threat-model.md`, `privacy-inventory.md`, `data-classification.md` | Security and data-governance controls                                                               | Mandatory for affected work          |
| `traceability.md`, `PHASE_EXECUTION_LOG.md`                         | Requirement traceability and historical record                                                      | Evidence/history                     |

## Do not use as implementation authority

`enterprise-enhancements/` is retained as an untracked exploratory proposal set. It contains unsupported claims about features that do not exist. Do not use it for implementation, estimates or status reporting unless an Owner-approved ADR explicitly incorporates a proposal into the SRS.

## Status vocabulary

- **Planned:** specified; no product code/evidence.
- **Implemented:** code plus automated test evidence exists.
- **Verified:** phase report/audit evidence confirms it.
- **Blocked:** an external decision, account, legal approval or proof is required; see the gap register.
