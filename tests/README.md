# tests/

Cross-cutting tests that do not belong to a single package (SRS section 4.4):

- **Isolation suite** (Phase 1, merge gate): auto-discovers every table with `workspace_id` and proves workspace A cannot read or write workspace B (SRS 5.3, SEC-02). The proven pattern is in `spikes/spike-b-rls-pooling`.
- **E2E** (Playwright): the audit-checkpoint scenario of each phase.
- **Load** (k6): public site path and the AI queue (Phases 4 and 8).

Empty in Phase 0 on purpose: there is no product code to test yet.
