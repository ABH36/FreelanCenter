// P3 S6 (DG-35): sets the dashboard's Production variables for the asset library (Cloudflare R2, ADR-009).
// The Owner runs this on their own machine; no secret is ever printed, logged or passed on a command line.
// Values reach Vercel only through the CLI's stdin; the access key pair goes in as Sensitive variables.
//
//   node scripts/ops/set-dashboard-asset-env.mjs            (dry run: names and non-secret values only)
//   node scripts/ops/set-dashboard-asset-env.mjs --apply    (writes the variables that are missing)
//
// Source: the seven ASSET_* lines the Owner adds to the repository's .env.local (git-ignored) after creating the R2
// buckets and token (docs/reports/PHASE_3_S6_ASSET_LIBRARY.md section 7):
//   ASSET_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
//   ASSET_S3_REGION=auto
//   ASSET_S3_ACCESS_KEY_ID=<R2 token access key id>
//   ASSET_S3_SECRET_ACCESS_KEY=<R2 token secret access key>
//   ASSET_UPLOAD_BUCKET=uploads
//   ASSET_PUBLIC_BUCKET=assets
//   ASSET_PUBLIC_URL=https://pub-<id>.r2.dev
// Put them in .env.local only for this run: the dashboard reads them locally too, and local development should keep
// using S3Mock. Remove the lines after --apply. An existing Vercel variable is never overwritten (rotation is
// `vercel env rm <name> production` first).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dashboard = path.join(root, 'apps/dashboard');
const apply = process.argv.includes('--apply');

function readEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const local = readEnvFile(path.join(root, '.env.local'));
const get = (name) => {
  const value = local[name];
  if (!value) fail(`${name} is missing in .env.local`);
  return value;
};

function httpsUrl(name, hostCheck, hint) {
  const value = get(name);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${name} in .env.local is not a URL`);
  }
  if (
    url.protocol !== 'https:' ||
    !hostCheck(url.hostname) ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    fail(`${name} must look like ${hint}`);
  }
  return value.replace(/\/+$/, '');
}

const bucket = (name) => {
  const value = get(name);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(value)) fail(`${name} is not a valid bucket name`);
  return value;
};

const endpoint = httpsUrl(
  'ASSET_S3_ENDPOINT',
  (h) => /^[0-9a-f]{32}\.(eu\.)?r2\.cloudflarestorage\.com$/.test(h),
  'https://<32-hex account id>.r2.cloudflarestorage.com (no bucket in the path)',
);
const publicUrl = httpsUrl(
  'ASSET_PUBLIC_URL',
  (h) => /\.r2\.dev$/.test(h) || !/cloudflarestorage\.com$/.test(h),
  'https://pub-<id>.r2.dev (the public bucket URL, not the S3 API endpoint)',
);
const uploadBucket = bucket('ASSET_UPLOAD_BUCKET');
const publicBucket = bucket('ASSET_PUBLIC_BUCKET');
if (uploadBucket === publicBucket)
  fail('ASSET_UPLOAD_BUCKET and ASSET_PUBLIC_BUCKET must be different buckets');
const region = local.ASSET_S3_REGION || 'auto';
const accessKeyId = get('ASSET_S3_ACCESS_KEY_ID');
const secretAccessKey = get('ASSET_S3_SECRET_ACCESS_KEY');
if (!/^[0-9a-f]{32}$/.test(accessKeyId))
  fail('ASSET_S3_ACCESS_KEY_ID does not look like an R2 access key id');
if (!/^[0-9a-f]{64}$/.test(secretAccessKey))
  fail('ASSET_S3_SECRET_ACCESS_KEY does not look like an R2 secret key');

const variables = [
  { name: 'ASSET_S3_ENDPOINT', value: endpoint, sensitive: false, show: true },
  { name: 'ASSET_S3_REGION', value: region, sensitive: false, show: true },
  { name: 'ASSET_S3_ACCESS_KEY_ID', value: accessKeyId, sensitive: true },
  { name: 'ASSET_S3_SECRET_ACCESS_KEY', value: secretAccessKey, sensitive: true },
  { name: 'ASSET_UPLOAD_BUCKET', value: uploadBucket, sensitive: false, show: true },
  { name: 'ASSET_PUBLIC_BUCKET', value: publicBucket, sensitive: false, show: true },
  { name: 'ASSET_PUBLIC_URL', value: publicUrl, sensitive: false, show: true },
];

function vercel(args, input) {
  const result = spawnSync('vercel', args, {
    cwd: dashboard,
    input,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const listed = vercel(['env', 'ls', 'production']);
if (!listed.ok) fail('`vercel env ls production` failed; run `vercel login` and link apps/dashboard first');
const existing = new Set(
  listed.out
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => /^[A-Z][A-Z0-9_]+$/.test(n)),
);

console.log(`dashboard Production asset storage (${apply ? 'apply' : 'dry run'}):`);
let failed = false;
for (const v of variables) {
  const label = `${v.name.padEnd(28)} ${v.sensitive ? 'sensitive' : 'plain    '}`;
  if (existing.has(v.name)) {
    console.log(`  skip  ${label} already set (not overwritten)`);
    continue;
  }
  if (!apply) {
    console.log(`  add   ${label} ${v.show ? v.value : '(value hidden)'}`);
    continue;
  }
  const args = ['env', 'add', v.name, 'production', v.sensitive ? '--sensitive' : '--no-sensitive'];
  const result = vercel(args, v.value);
  // The CLI output never contains the value (it came in on stdin); still, print only the status.
  console.log(`  ${result.ok ? 'added' : 'FAIL '} ${label}`);
  if (!result.ok) failed = true;
}
if (!apply) console.log('\nNothing was written. Run again with --apply to write the missing variables.');
else
  console.log(
    '\nNext: remove the ASSET_* lines from .env.local, then Claude redeploys production (after you confirm) and checks an upload.',
  );
process.exit(failed ? 1 : 0);
