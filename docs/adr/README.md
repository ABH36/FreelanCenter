# Architecture Decision Records

Format: context, options, decision, consequences, evidence, revisit-when. One decision per file. A decision changes only by a new ADR that supersedes the old one.

**Status vocabulary (used honestly):**

- **Accepted (verified)** - decided and checked by running something in Phase 0.
- **Accepted for planning** - decided as the working assumption; a named check is still outstanding and is listed in the ADR.
- **Proposed** - needs the Owner's (or Architect's) ratification before it binds.

| ADR                                               | Decision                                                                             | Status                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| [001](001-monorepo-and-toolchain.md)              | Monorepo, pnpm + Turborepo, strict TypeScript, pinned toolchain                      | Accepted (verified)                                                                          |
| [002](002-two-apps-two-domains.md)                | Dashboard and tenant sites are separate apps on separate registrable domains         | Accepted (verified: lint boundary + separate apps)                                           |
| [003](003-database-supabase-mumbai-prisma-rls.md) | Supabase Postgres in Mumbai, Prisma 7, RLS with transaction-local context            | Accepted for planning (pattern verified locally; Supabase re-verification is Phase 1 task 1) |
| [004](004-declarative-templates.md)               | Templates are declarative in v1                                                      | Accepted for planning                                                                        |
| [005](005-domain-provider-hard-rule.md)           | Vercel-hosted sites use the Vercel Domains API; never proxy Vercel behind Cloudflare | Accepted for planning (Spike A not executed)                                                 |
| [006](006-authentication.md)                      | Better Auth, self-managed                                                            | Accepted (verified: Spike F incl. live Google; Owner ratified 2026-10-22)                    |
| [007](007-durable-jobs-inngest.md)                | Inngest for durable jobs                                                             | Accepted 2026-10-22 (Spike G local; Cloud live run pending)                                  |
| [008](008-ai-anthropic-ai-sdk.md)                 | Anthropic through AI SDK v7, patch-based edits, credit ledger                        | Accepted for planning (offline half verified; live half needs a key)                         |
| [009](009-object-storage-and-images.md)           | R2 + pre-generated variants; Next image optimizer disabled                           | Accepted for planning (modelled, one sample)                                                 |
| [010](010-vector-store-pgvector.md)               | pgvector in the same Postgres                                                        | Accepted for planning                                                                        |
| [011](011-payments-provider.md)                   | Razorpay behind `PaymentProvider`                                                    | Proposed (needs Owner, Spike D not executed)                                                 |
| [012](012-email-and-messaging.md)                 | Resend/Postmark transactional; per-workspace sending for white-label                 | Proposed                                                                                     |
| [013](013-data-residency.md)                      | Mumbai-first regions, documented cross-border processors                             | Accepted (D14 locked)                                                                        |
