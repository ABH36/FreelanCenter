# Spike E - image pipeline: variants and delivery cost

**Status: PARTIAL. Variant sizes/encode times MEASURED (real, one sample photo). Cost comparison is a MODEL with stated assumptions.**
Code: [spikes/spike-e-images](../../spikes/spike-e-images) · Raw: `results/spike-e-variants.json`, `results/spike-e-cost-model.json`
Reproduce: download the sample photo (it is git-ignored, it is a third-party image), then measure and model:

```bash
cd spikes/spike-e-images && mkdir -p assets
curl -sSL -o assets/sample-photo-2400.jpg "https://picsum.photos/id/1011/2400/1600"
pnpm spike:measure && pnpm spike:cost
```

## Measured (sharp 0.35.4, one public 2400x1600 JPEG, median of 3 encodes)

| Width            | WebP q78             | AVIF q50 (effort 4)  | JPEG q78 mozjpeg  |
| ---------------- | -------------------- | -------------------- | ----------------- |
| 400              | 9.8 KB / 48 ms       | 7.1 KB / 339 ms      | 12.4 KB / 72 ms   |
| 800              | 25.9 KB / 154 ms     | 18.8 KB / 923 ms     | 35.9 KB / 108 ms  |
| 1200             | 46.6 KB / 160 ms     | 33.8 KB / 1479 ms    | 67.3 KB / 138 ms  |
| 1600             | 68.4 KB / 241 ms     | 50.9 KB / 2657 ms    | 105.5 KB / 211 ms |
| **All 4 widths** | **150.7 KB / 0.6 s** | **110.7 KB / 5.4 s** | 221.1 KB / 0.5 s  |

- AVIF is ~27% smaller than WebP but ~9x slower to encode. Generating AVIF for every upload costs ~5.4 CPU-seconds per image.
- **Caveat:** a single photo. Content-dependent; treat as order of magnitude. Variant size depends on output width, not on the size of the original.

## Modelled (assumptions marked A in the script; prices from vendor pages read 2026-09-21)

Workload: 25,000 sites (SRS), 15 images/site (A), 8 image requests/visit (A), visits/site/month 500 / 1,500 / 5,000 (A), avg delivered image = measured WebP mean 37.7 KB.

| Option                                                                          | 500 visits        | 1,500 visits (base) | 5,000 visits         |
| ------------------------------------------------------------------------------- | ----------------- | ------------------- | -------------------- |
| **A** Next.js/Vercel optimizer (Vercel CDN delivery)                            | $854 - $1,782 /mo | $2,404 - $5,091 /mo | $7,830 - $16,674 /mo |
| **B** R2 + variants pre-generated at upload, Cloudflare CDN on our asset domain | ~$18 /mo          | ~$20 /mo            | ~$33 /mo             |
| **C** R2 originals + Cloudflare Image Transformations                           | ~$577 /mo         | ~$579 /mo           | ~$591 /mo            |

B also needs a one-time ~$15 to generate the initial variant set and ~50 encode CPU-hours per month at 8% monthly churn (compute not priced).

## What the model says (and does not)

1. **Direction is robust to the assumptions; magnitude is not.** A scales with traffic (bandwidth), B barely moves. Even with the most favourable Vercel regional rates, A is ~47x B at the low-traffic scenario and ~120x B at base traffic ($2,404 vs $20).
2. **The cost driver is bandwidth, not transformations.** Vercel's transformation fee is small ($0.05-$0.08 per 1K). Fast Data Transfer ($0.15-$0.35 per GB) and edge requests dominate A. Cloudflare R2 has **zero egress fees**. This corrects the reasoning of Architect finding F-05 ("the optimizer is expensive per transformation") while agreeing with its conclusion (do not use the Vercel optimizer).
3. C is 30x B: Cloudflare's per-unique-transformation price ($0.50/1K) is 10x Vercel's. On-demand transformation only makes sense for rare/custom sizes.
4. Not modelled: HTML/JS delivery (same in all options), platform plan fees, Vercel Flat Rate CDN (could shrink A), Cloudflare CDN fair-use terms for image traffic (verify), encode compute price.

## Recommendation for ADR-009 (needs Owner ratification only if assumptions change)

R2 + pre-generated variants served from Cloudflare on our own asset domain; Next.js image optimizer disabled. Generate **WebP for every upload** (0.6 s/image) and treat **AVIF as optional** (lower `effort`, or lazily for popular images) because it costs 9x the CPU for ~27% fewer bytes.

## Open

- Re-measure with 10-20 real customer photos (dark, detailed, screenshots, logos).
- Replace assumptions (visits/site, images/site) with real analytics after the beta.
- Confirm Cloudflare zone plan and R2 location hint (R2 has no India-specific location; delivery is via CDN).
