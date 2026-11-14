/**
 * P3 S3: the editor preview (app/(app)/w/[slug]/projects/[projectId]/preview) renders drafts inside the dashboard, so
 * the dashboard serves the template fonts itself (`public/preview-fonts`, same origin, no third-party request). The
 * allow-list and the copy logic are the sites app's (`apps/sites/scripts/copy-fonts.mjs`, checked against the
 * `@platform/ui` policy by `apps/sites/lib/fonts.test.ts`), so the two apps can never serve different fonts.
 * Run by `predev` and `prebuild`; the output is generated and git-ignored.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { copyFonts } from '../../sites/scripts/copy-fonts.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'preview-fonts');
const copied = copyFonts(out);
if (copied === 0 || !existsSync(out)) throw new Error('No font files were copied');
process.stdout.write(`copy-preview-fonts: ${copied} files -> public/preview-fonts\n`);
