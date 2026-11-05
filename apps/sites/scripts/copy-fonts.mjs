/**
 * Copies the self-hosted woff2 files of the font allow-list from `@fontsource/*` into `public/fonts` (served from our
 * own origin, no third-party font request at runtime; SRS 5.2, Q19). Run by `predev` and `prebuild`; the output is
 * generated and git-ignored. Only the Latin and Devanagari subsets at weights 400 and 700 are copied; the policy
 * lives in `@platform/ui` (`fonts.ts`) and `lib/fonts.test.ts` fails if the two ever disagree.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const FONT_SLUGS = [
  'inter',
  'poppins',
  'montserrat',
  'lato',
  'roboto',
  'open-sans',
  'playfair-display',
  'hind',
  'mukta',
  'noto-sans-devanagari',
];

const WANTED = /^(?<slug>[a-z-]+)-(latin|devanagari)-(400|700)-normal\.woff2$/;

export function copyFonts(outDir) {
  const require = createRequire(import.meta.url);
  mkdirSync(outDir, { recursive: true });
  let copied = 0;
  for (const slug of FONT_SLUGS) {
    const filesDir = join(dirname(require.resolve(`@fontsource/${slug}/package.json`)), 'files');
    for (const file of readdirSync(filesDir)) {
      const match = WANTED.exec(file);
      if (match?.groups?.slug === slug) {
        copyFileSync(join(filesDir, file), join(outDir, file));
        copied += 1;
      }
    }
  }
  return copied;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
  const copied = copyFonts(out);
  if (copied === 0 || !existsSync(out)) throw new Error('No font files were copied');
  process.stdout.write(`copy-fonts: ${copied} files -> public/fonts\n`);
}
