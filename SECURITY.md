# Security Policy

**Status: pre-launch.** The platform is not deployed. This file is the engineering baseline; the public contact below must be filled in by the Owner before any beta.

## Reporting a vulnerability

TODO(Owner): security contact address and PGP key. Until then, do not open public issues for vulnerabilities.

## Engineering rules (see SRS Section 9)

- Tenant isolation is enforced by PostgreSQL RLS; the cross-tenant isolation suite is a merge gate (SEC-01/02).
- Secrets never live in code, logs, prompts or client bundles; `.env*` is git-ignored; gitleaks runs in CI (SEC-05).
- Dependency install scripts are denied by default; additions to `allowBuilds` in `pnpm-workspace.yaml` need a written reason (SEC-13).
- Tenant-supplied content is rendered as data only; `dangerouslySetInnerHTML` is a lint error (SEC-04).
- The dashboard and tenant sites live on separate registrable domains and never share cookies (ADR-002).
