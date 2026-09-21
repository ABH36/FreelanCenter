# ADR-010: Vector store - pgvector in the same Postgres

**Status:** Accepted for planning · **Date:** 2026-09-21 · **SRS:** C9, FR-LEAD-08

## Decision

Chatbot retrieval uses `pgvector` in the primary Postgres (`EmbeddingChunk` with `workspace_id`, RLS applies). Each site's corpus is a few KB, so a separate vector database is unnecessary cost and breaks the single isolation story. Supabase supports the extension (search summary; confirm on the actual project).

## Consequences

- One backup, one RLS model, no extra vendor. - Embedding/index maintenance load sits on the main database; monitor and move to a read replica or dedicated store only if an ADR shows the need.

## Verification owed

Enable and query `vector` on the real Supabase project (Phase 1 pooler re-verification is a convenient moment); not needed until Phase 5.
