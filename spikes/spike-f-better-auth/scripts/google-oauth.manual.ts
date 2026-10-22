/**
 * SPIKE F - MANUAL Google OAuth round trip (needs a human in a browser). Not part of `pnpm spike:test`.
 *
 *   Prerequisites: the Docker stack is up (pnpm spike:up), GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are in the
 *   repository's git-ignored .env.local, and the Google OAuth client lists the authorised redirect URI
 *   http://localhost:3000/api/auth/callback/google
 *
 *   pnpm spike:oauth   then open http://localhost:3000/start and sign in with a Google TEST account.
 *
 * It serves Better Auth on localhost:3000, waits up to 5 minutes for the callback, asserts the result in the
 * database and writes results/spike-f-google-oauth.json. It never prints tokens, secrets or the full email.
 */
import fs from 'node:fs';
import http from 'node:http';
import pg from 'pg';
import { expect, it } from 'vitest';
import { type AuditEvent, type SentMail, URL_AUTH, URL_SUPERUSER, makeAuth, makePrisma } from '../src/auth';

function loadLocalEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync('../../.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) values[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return values;
}

const maskEmail = (e: string) => e.replace(/^(.).*(@.*)$/, '$1***$2');

it('completes a real Google sign-in and links a verified account', { timeout: 6 * 60_000 }, async () => {
  const env = loadLocalEnv();
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_* missing from .env.local');
  const prisma = makePrisma(URL_AUTH);
  const audit: AuditEvent[] = [];
  const auth = makeAuth({
    prisma,
    mail: [] as SentMail[],
    audit,
    google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  });

  let done: (status: number) => void = () => {};
  const finished = new Promise<number>((resolve) => (done = resolve));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost:3000');
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    if (url.pathname === '/start') {
      const r = await auth.handler(
        new Request('http://localhost:3000/api/auth/sign-in/social', {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
          body: JSON.stringify({ provider: 'google', callbackURL: '/done' }),
        }),
      );
      const { url: to } = (await r.json()) as { url: string };
      res.writeHead(302, { location: to, 'set-cookie': r.headers.getSetCookie() });
      return res.end();
    }
    if (url.pathname === '/done' || url.pathname.startsWith('/api/auth/error')) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(url.pathname === '/done' ? 'Signed in. You can close this tab.' : `Auth error: ${url.search}`);
      return done(url.pathname === '/done' ? 200 : 400);
    }
    if (url.pathname.startsWith('/api/auth/')) {
      const r = await auth.handler(new Request(url, { method: req.method, headers }));
      res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'set-cookie': r.headers.getSetCookie() });
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    res.writeHead(404).end();
  });
  // Bind dual-stack (no host). Binding only 127.0.0.1 succeeds even when another server (e.g. `pnpm dev`)
  // holds [::]:3000, and browsers resolve localhost to ::1 first, so they would silently reach that server.
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) =>
      reject(
        e.code === 'EADDRINUSE'
          ? new Error('Port 3000 is in use (is `pnpm dev` running?). Stop it, then re-run pnpm spike:oauth.')
          : e,
      ),
    );
    server.listen(3000, resolve);
  });
  console.log('\n>>> Open http://localhost:3000/start and sign in with a Google test account (5 min).\n');

  const status = await Promise.race([
    finished,
    new Promise<number>((r) => setTimeout(() => r(408), 5 * 60_000)),
  ]);
  server.close();

  const su = new pg.Pool({ connectionString: URL_SUPERUSER, max: 1 });
  const rows = (
    await su.query(
      `SELECT u.email, u.email_verified, a.provider_id, (a.access_token IS NOT NULL) has_access_token,
              (a.id_token IS NOT NULL) has_id_token, a.scope,
              (a.access_token ~ '^ya29\\.') access_token_plain, (a.id_token ~ '^eyJ') id_token_plain
         FROM identity.accounts a JOIN identity.users u ON u.id = a.user_id
        WHERE a.provider_id = 'google' ORDER BY a.created_at DESC LIMIT 1`,
    )
  ).rows as Array<{
    email: string;
    email_verified: boolean;
    provider_id: string;
    scope: string;
    access_token_plain: boolean;
    id_token_plain: boolean;
  }>;
  await su.end();
  await prisma.$disconnect();

  const row = rows[0];
  const evidence = {
    executedAt: new Date().toISOString(),
    callbackStatus: status,
    account: row ? { ...row, email: maskEmail(row.email) } : null,
    auditActions: [...new Set(audit.map((a) => a.action))].sort(),
  };
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync('results/spike-f-google-oauth.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));

  expect(status).toBe(200);
  expect(row?.provider_id).toBe('google');
  expect(row?.email_verified).toBe(true);
  // F-10: provider tokens must be encrypted at rest (account.encryptOAuthTokens).
  expect(row?.access_token_plain).toBe(false);
  expect(row?.id_token_plain).toBe(false);
});
