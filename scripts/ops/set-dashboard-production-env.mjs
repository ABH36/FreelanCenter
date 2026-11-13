// P3 S0 (DASHBOARD_GO_LIVE_PLAN.md §3.1): sets the dashboard Production variables of the private technical go-live.
// The Owner runs this on their own machine; no value is ever printed, logged or passed on a command line.
// Values reach Vercel only through the CLI's stdin, as Sensitive variables where they are secrets.
//
//   node scripts/ops/set-dashboard-production-env.mjs            (dry run: names and non-secret values only)
//   node scripts/ops/set-dashboard-production-env.mjs --apply    (writes the variables that are missing)
//
// Sources: DATABASE_URL, DATABASE_URL_AUTH and EMAIL_PROVIDER_API_KEY come from the repository's .env.local (the same
// live values `db:verify --target env` uses). BETTER_AUTH_SECRET is generated here (32 random bytes) and goes straight
// to Vercel: it is never written anywhere else, so it cannot be read back (rotate by removing it and running again).
// An existing variable is never overwritten (rollback/rotation is `vercel env rm <name> production` first).
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dashboard = path.join(root, 'apps/dashboard');
const apply = process.argv.includes('--apply');

const PRODUCTION_ORIGIN = 'https://dashboard-liard-tau-14.vercel.app';
// Resend's shared test sender: delivers only to the address that owns the Resend account. Until a sending domain is
// verified (DG-10) this is what keeps the dashboard private: nobody else can receive a verification e-mail.
const EMAIL_FROM = 'FreelanCenter <onboarding@resend.dev>';

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

function liveDatabaseUrl(key, role) {
  const value = local[key];
  if (!value) fail(`${key} is missing in .env.local`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${key} in .env.local is not a URL`);
  }
  const user = decodeURIComponent(url.username).split('.')[0];
  if (user !== role) fail(`${key} must use the ${role} role (found another role)`);
  if (!url.hostname.endsWith('.pooler.supabase.com') || url.port !== '6543') {
    fail(`${key} must be the transaction-mode pooler URL (port 6543) of the live database`);
  }
  return value;
}

const emailKey = local.EMAIL_PROVIDER_API_KEY;
if (!emailKey?.startsWith('re_')) fail('EMAIL_PROVIDER_API_KEY in .env.local is not a Resend key');

/** name -> { value, sensitive, show (non-secret values may be shown in the dry run) } */
const variables = [
  { name: 'DATABASE_URL', value: liveDatabaseUrl('DATABASE_URL', 'app_user'), sensitive: true },
  { name: 'DATABASE_URL_AUTH', value: liveDatabaseUrl('DATABASE_URL_AUTH', 'app_auth'), sensitive: true },
  { name: 'BETTER_AUTH_SECRET', value: randomBytes(32).toString('base64url'), sensitive: true },
  { name: 'BETTER_AUTH_URL', value: PRODUCTION_ORIGIN, sensitive: false, show: true },
  { name: 'EMAIL_TRANSPORT', value: 'resend', sensitive: false, show: true },
  { name: 'EMAIL_PROVIDER_API_KEY', value: emailKey, sensitive: true },
  { name: 'EMAIL_FROM', value: EMAIL_FROM, sensitive: false, show: true },
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

console.log(`dashboard Production (${apply ? 'apply' : 'dry run'}):`);
let failed = false;
for (const v of variables) {
  const label = `${v.name.padEnd(24)} ${v.sensitive ? 'sensitive' : 'plain    '}`;
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
else console.log('\nNext: redeploy production (Claude does this after you confirm), then the smoke test.');
process.exit(failed ? 1 : 0);
