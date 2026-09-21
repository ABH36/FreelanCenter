/**
 * SPIKE E (part 2) - image-delivery cost model. This is a MODEL, not a measurement: every workload figure below is an
 * ASSUMPTION (marked A) and every price is taken from vendor pages read on 2026-09-21 (marked with its source).
 * Change the assumptions and re-run: `pnpm spike:cost`.
 *
 * Question it answers (SRS ADR-009 / Architect finding F-05): for tiny local-business sites, where does image money go,
 * and is "R2 + pre-generated variants, Next.js optimizer disabled" actually the cheapest option?
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// ---- prices (USD) ----------------------------------------------------------------------------------------------------
const PRICE = {
  // https://vercel.com/docs/pricing/regional-pricing (range = cheapest..dearest region; bom1 exact value not read)
  vercel: {
    fastDataTransferPerGB: [0.15, 0.35],
    edgeRequestsPerM: [2.0, 3.2],
    imgTransformPer1K: [0.05, 0.0812],
    imgCacheReadPerM: [0.4, 0.64],
    imgCacheWritePerM: [4.0, 6.4],
  },
  // https://developers.cloudflare.com/r2/pricing (standard storage) - egress is free
  r2: {
    storagePerGBMonth: 0.015,
    classAPerM: 4.5,
    classBPerM: 0.36,
    freeClassBPerMonth: 10_000_000,
    freeClassAPerMonth: 1_000_000,
    freeGB: 10,
  },
  // https://developers.cloudflare.com/images/pricing/ (unique transformations, images stored elsewhere)
  cfImages: { transformPer1K: 0.5, freeTransforms: 5_000 },
} as const;

// ---- workload assumptions (A) ---------------------------------------------------------------------------------------
const SCENARIOS = {
  // visits/site/month is the big unknown. SRS NFR-SCALE-02 gives sites=25,000 and 1M visitor requests/day platform-wide.
  low: { visitsPerSiteMonth: 500 },
  base: { visitsPerSiteMonth: 1_500 },
  high: { visitsPerSiteMonth: 5_000 },
};
const A = {
  sites: 25_000, // SRS NFR-SCALE-02
  imagesPerSite: 15, // A
  originalBytes: 3_000_000, // A: phone photo kept as the master
  widthsUsed: 3, // A: distinct widths actually requested per image per month (srcset picks one per device class)
  variantsPreGenerated: 4 * 2, // 4 widths x (webp+avif); see measure-variants.ts
  imageRequestsPerVisit: 8, // A
  cdnMissRate: 0.05, // A: share of image requests that reach origin/global cache
  monthlyUploadShare: 0.08, // A: share of all images that are new/replaced each month
  refreshesPerMonth: 1, // A: Next optimizer revalidations per cached image (long minimumCacheTTL assumed)
};

const measured = existsSync('results/spike-e-variants.json')
  ? JSON.parse(readFileSync('results/spike-e-variants.json', 'utf8'))
  : null;
// average delivered bytes: mean of webp variants (what most browsers get). Fallback if measure-variants was not run.
const avgDeliveredBytes: number = measured ? measured.perFormat.webp.avgBytesPerVariant : 60_000;
const variantSetBytes: number = measured
  ? measured.perFormat.webp.bytesForAllWidths + measured.perFormat.avif.bytesForAllWidths
  : 8 * 60_000;
const encodeSecondsPerImage: number = measured
  ? (measured.perFormat.webp.encodeMsAllWidths + measured.perFormat.avif.encodeMsAllWidths) / 1000
  : 3;

const units = (bytes: number) => Math.ceil(bytes / 8192); // Vercel bills cache read/write in 8 KB units
const usd = (n: number) => +n.toFixed(2);
const range = (f: (i: 0 | 1) => number) => ({ low: usd(f(0)), high: usd(f(1)) });

function model(visitsPerSiteMonth: number) {
  const images = A.sites * A.imagesPerSite;
  const requests = A.sites * visitsPerSiteMonth * A.imageRequestsPerVisit;
  const gbDelivered = (requests * avgDeliveredBytes) / 1e9;
  const uniqueTransforms = images * A.widthsUsed;
  const originalsGB = (images * A.originalBytes) / 1e9;
  const r2OriginalsCost = Math.max(0, originalsGB - PRICE.r2.freeGB) * PRICE.r2.storagePerGBMonth;

  // Option A: Next.js/Vercel optimizer, images served through Vercel's CDN
  const v = PRICE.vercel;
  const optimizerA = range((i) => {
    const transforms = uniqueTransforms * A.refreshesPerMonth;
    return (
      (transforms / 1000) * v.imgTransformPer1K[i] +
      ((transforms * units(avgDeliveredBytes)) / 1e6) * v.imgCacheWritePerM[i] +
      ((requests * A.cdnMissRate * units(avgDeliveredBytes)) / 1e6) * v.imgCacheReadPerM[i] +
      gbDelivered * v.fastDataTransferPerGB[i] +
      (requests / 1e6) * v.edgeRequestsPerM[i]
    );
  });

  // Option B: R2 + variants generated once at upload, served via Cloudflare CDN on our asset domain (steady state)
  const r = PRICE.r2;
  const variantsGB = (images * variantSetBytes) / 1e9;
  const newImages = images * A.monthlyUploadShare;
  const classA = Math.max(0, newImages * (A.variantsPreGenerated + 1) - r.freeClassAPerMonth);
  const classB = Math.max(0, requests * A.cdnMissRate - r.freeClassBPerMonth);
  const preGen = usd(
    Math.max(0, originalsGB + variantsGB - r.freeGB) * r.storagePerGBMonth +
      (classA / 1e6) * r.classAPerM +
      (classB / 1e6) * r.classBPerM,
  );
  const preGenInitialOneTime = usd(((images * (A.variantsPreGenerated + 1)) / 1e6) * r.classAPerM);
  const encodeCpuHoursPerMonth = +((newImages * encodeSecondsPerImage) / 3600).toFixed(1);

  // Option C: R2 originals + Cloudflare Image Transformations on demand (billed per UNIQUE transformation per month)
  const cf = PRICE.cfImages;
  const transformsC = Math.max(0, uniqueTransforms - cf.freeTransforms);
  const cfTransform = usd(
    (transformsC / 1000) * cf.transformPer1K +
      r2OriginalsCost +
      (Math.max(0, requests * A.cdnMissRate - r.freeClassBPerMonth) / 1e6) * r.classBPerM,
  );

  return {
    imageRequestsPerMonth: requests,
    gbDeliveredPerMonth: Math.round(gbDelivered),
    uniqueTransformsPerMonth: uniqueTransforms,
    A_vercelOptimizer_usdPerMonth: optimizerA,
    B_r2PreGenerated_usdPerMonth: preGen,
    C_cloudflareTransformations_usdPerMonth: cfTransform,
    B_oneTimeInitialGenerationUsd: preGenInitialOneTime,
    B_encodeCpuHoursPerMonthSteadyState: encodeCpuHoursPerMonth,
    perSitePerMonthUsd: {
      A: { low: usd(optimizerA.low / A.sites), high: usd(optimizerA.high / A.sites) },
      B: usd(preGen / A.sites),
      C: usd(cfTransform / A.sites),
    },
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  basis:
    'MODEL: workload figures are assumptions; prices from vendor pages read 2026-09-21; Vercel bom1 exact rate not read (range shown)',
  assumptions: {
    ...A,
    avgDeliveredBytes,
    variantSetBytes,
    encodeSecondsPerImage,
    usedMeasuredVariants: Boolean(measured),
  },
  prices: PRICE,
  scenarios: Object.fromEntries(
    Object.entries(SCENARIOS).map(([k, s]) => [
      k,
      { visitsPerSiteMonth: s.visitsPerSiteMonth, ...model(s.visitsPerSiteMonth) },
    ]),
  ),
  notEstimated: [
    'HTML/JS/CSS delivery (identical in all options)',
    'Vercel Pro seat/base fee',
    'Cloudflare plan fee for the asset zone',
    'encode compute price (hours reported instead)',
  ],
};
mkdirSync('results', { recursive: true });
writeFileSync('results/spike-e-cost-model.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.scenarios, null, 2));
