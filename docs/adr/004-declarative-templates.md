# ADR-004: Templates are declarative in v1

**Status:** Accepted for planning · **Date:** 2026-09-21 · **SRS:** C5, SEC-16, R7, D9

## Context

Marketplace creators must be able to sell templates, but arbitrary creator-supplied code (React, scripts) would execute on shared origins under our control and could attack visitors, other tenants or the platform.

## Decision

A template is **data**: design tokens, page/section layout, per-block variants, animation presets and an onboarding manifest, validated by Zod and rendered by **platform-owned Blocks**. A creator differentiates through composition, variants and tokens, not code. Custom components are a v2 topic and would need a sandbox (isolated origin/iframe, review) that is out of scope now.

## Consequences

- No creator code runs in production; vetting is schema validation plus content checks. + AI edits and client onboarding target the same typed document.

* Creator freedom is bounded by the block library; the block set and variants become the product's quality ceiling. Phase 2 must ship enough blocks/variants for 3 distinct templates without renderer changes (acceptance criterion).

## Evidence

Spike C shows a strict closed-schema config plus closed operation set is practical and rejects HTML/URL/unknown-key injection deterministically (24 offline tests).
