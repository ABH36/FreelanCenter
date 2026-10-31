# tests/

Cross-cutting tests that do not belong to a single package (SRS section 4.4):

- **Isolation suite** (`tests/isolation`, Phase 1 slice 2, merge gate SEC-02). It discovers every relation in the product schemas from the catalog and requires each one to be classified in `src/factories.ts`, so a new tenant table cannot ship without a row factory. For every tenant table it proves that workspace A cannot SELECT/INSERT/UPDATE/DELETE workspace B's rows, including through joins, `RETURNING`, writable CTEs, blind writes and raw queries, with no context and with actor-only context. The IDOR harness (`@platform/isolation-tests/idor`) checks every resource type and is reused by later slices. Run it against the local stack:

  ```sh
  pnpm --filter @platform/db db:setup
  pnpm --filter @platform/isolation-tests test:isolation   # the suite, one line per table and check
  pnpm --filter @platform/isolation-tests test:mutation    # proves the suite catches seven isolation bugs
  ```

- **E2E** (`tests/e2e`, Playwright, Phase 1 slice 9): the audit-checkpoint scenario of each phase. Phase 1: sign-up, e-mail verification, workspace, project, subdomain; a second tenant denied through the UI, the API and `app_user` SQL. Local runs need the Docker stack, and refuse any non-local database.

  ```sh
  pnpm --filter @platform/db db:setup
  pnpm --filter @platform/e2e exec playwright install chromium   # once
  pnpm --filter @platform/e2e test:e2e
  ```

- **Load** (k6): the public site path and the AI queue (Phases 4 and 8).
