# ADR-009: Object storage and images - Cloudflare R2, pre-generated variants, no Next.js image optimizer

**Status:** Accepted for planning (modelled on one sample photo) · **Date:** 2026-09-21 · **SRS:** FR-BLD-05, F-05, R17

## Decision

- **Storage:** Cloudflare R2 (no egress fees), served through Cloudflare's CDN on **our own asset domain** (works under either ADR-005 option). Keys prefixed `ws/<workspace_id>/...`; signed uploads; magic-byte sniffing, size caps, re-encode, EXIF strip (SEC-08).
- **Images:** the Next.js/Vercel image optimizer is **disabled**. Variants (widths 400/800/1200/1600) are generated at upload and stored. **WebP always** (0.6 CPU-s/image); **AVIF optional** (9x the CPU for ~27% fewer bytes) - lazily or at lower effort.
- The renderer references variants through fixed presets only.

## Why (Spike E)

Modelled at 25,000 sites: Vercel optimizer path ~$2.4k-$5.1k/month at 1,500 visits/site vs ~$20 for R2 pre-generated vs ~$580 for Cloudflare on-demand transformations. **The driver is bandwidth (Fast Data Transfer and edge requests), not transformation fees** - Vercel's per-transformation price is lower than Cloudflare's. Direction is robust across 500-5,000 visits/site; magnitudes rest on assumptions.

## Consequences

- Predictable image cost that barely grows with traffic. - We own the image pipeline (encode jobs, cache invalidation, variant migrations). R2 has no India location hint; latency relies on the CDN.

## Revisit when

Real customer photos (10-20) are measured, real traffic data exists, or Cloudflare terms for image delivery on the chosen plan change.
