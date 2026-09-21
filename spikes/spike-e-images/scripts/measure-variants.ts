/**
 * SPIKE E (part 1) - REAL measurement: how big are pre-generated responsive variants and how long do they take to encode?
 * One public sample photo (assets/sample-photo-2400.jpg, 2400x1600). Real customer photos will differ in content, so treat
 * the numbers as an order-of-magnitude estimate, not a benchmark. Variant size depends on the OUTPUT width, not on the
 * size of the original, so a 6 MB phone photo produces roughly the same variants.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp, { type Sharp } from 'sharp';

const WIDTHS = [400, 800, 1200, 1600];
const FORMATS = [
  { name: 'webp', run: (s: Sharp) => s.webp({ quality: 78 }) },
  { name: 'avif', run: (s: Sharp) => s.avif({ quality: 50, effort: 4 }) },
  { name: 'jpeg', run: (s: Sharp) => s.jpeg({ quality: 78, mozjpeg: true }) },
] as const;

const source = readFileSync('assets/sample-photo-2400.jpg');
const meta = await sharp(source).metadata();

const variants: Array<{ width: number; format: string; bytes: number; encodeMs: number }> = [];
for (const width of WIDTHS) {
  for (const f of FORMATS) {
    // 3 timed runs, keep the median: first-call JIT/decoder warm-up would otherwise dominate
    const runs: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      const out = await f.run(sharp(source).rotate().resize({ width, withoutEnlargement: true })).toBuffer();
      runs.push(performance.now() - t);
      bytes = out.length;
    }
    runs.sort((a, b) => a - b);
    variants.push({ width, format: f.name, bytes, encodeMs: Math.round(runs[1] ?? 0) });
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const byFormat = (fmt: string) => variants.filter((v) => v.format === fmt);
const result = {
  measuredAt: new Date().toISOString(),
  sharpVersion: sharp.versions.sharp,
  sample: {
    file: 'assets/sample-photo-2400.jpg',
    width: meta.width,
    height: meta.height,
    bytes: source.length,
    note: 'single public photo (picsum id 1011); NOT representative of all customer photos',
  },
  widths: WIDTHS,
  variants,
  perFormat: Object.fromEntries(
    FORMATS.map((f) => [
      f.name,
      {
        bytesForAllWidths: sum(byFormat(f.name).map((v) => v.bytes)),
        avgBytesPerVariant: Math.round(sum(byFormat(f.name).map((v) => v.bytes)) / WIDTHS.length),
        encodeMsAllWidths: sum(byFormat(f.name).map((v) => v.encodeMs)),
      },
    ]),
  ),
};
mkdirSync('results', { recursive: true });
writeFileSync('results/spike-e-variants.json', JSON.stringify(result, null, 2));
console.table(variants);
console.log(JSON.stringify(result.perFormat, null, 2));
