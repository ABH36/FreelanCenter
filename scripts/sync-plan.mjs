// DEVELOPMENT_PLAN.md is a byte-identical mirror of SRS.md (SRS section 0.3), so that "the development plan" and
// "the SRS" can never be two different documents.
//   node scripts/sync-plan.mjs           copy SRS.md over DEVELOPMENT_PLAN.md
//   node scripts/sync-plan.mjs --check   fail (exit 1) if they differ; used by CI and `pnpm check`
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

const SRC = 'SRS.md';
const DST = 'DEVELOPMENT_PLAN.md';

if (process.argv.includes('--check')) {
  if (!existsSync(DST)) {
    console.error(`${DST} is missing. Run: pnpm sync-plan`);
    process.exit(1);
  }
  if (!readFileSync(SRC).equals(readFileSync(DST))) {
    console.error(`${DST} differs from ${SRC}. Edit only ${SRC}, then run: pnpm sync-plan`);
    process.exit(1);
  }
  console.log(`${DST} is byte-identical to ${SRC}`);
} else {
  copyFileSync(SRC, DST);
  console.log(`${DST} <- ${SRC} (${readFileSync(DST).length} bytes)`);
}
