/**
 * SPIKE F (DG-05): Better Auth 1.7 + Prisma 7 (adapter-pg) through transaction-mode PgBouncer,
 * with identity data separated from tenant data by DB role. Each `describe` names the SRS ids it evidences.
 */
import fs from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuditEvent,
  type SentMail,
  URL_APP,
  URL_AUTH,
  URL_SUPERUSER,
  makeAuth,
  makePrisma,
  uuidv7,
} from '../src/auth';
import { Browser } from '../src/http';
import { secretFromUri, totp } from '../src/totp';

const PASSWORD = 'correct-horse-battery-1';
const results: Record<string, unknown> = {};

const su = new pg.Pool({ connectionString: URL_SUPERUSER, max: 2 });
const authDb = makePrisma(URL_AUTH);
const appDb = makePrisma(URL_APP);
const mail: SentMail[] = [];
const audit: AuditEvent[] = [];
const auth = makeAuth({ prisma: authDb, mail, audit });

let ipSeq = 1;
const nextIp = () => {
  const n = ipSeq++;
  return `10.${Math.floor(n / 250)}.${(n % 250) + 1}.7`;
};
const browser = () => new Browser(auth, nextIp());

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await su.query(sql, params)).rows as T[];
}

function lastMail(kind: SentMail['kind'], to: string): SentMail {
  const m = [...mail].reverse().find((x) => x.kind === kind && x.to === to);
  if (!m) throw new Error(`no ${kind} mail for ${to}`);
  return m;
}

/** Sign up and verify through the real verification link; returns a signed-in browser. */
async function verifiedUser(email: string): Promise<{ b: Browser; userId: string }> {
  const b = browser();
  const r = await b.req('/sign-up/email', { body: { email, password: PASSWORD, name: 'Spike User' } });
  expect(r.status).toBe(200);
  const v = await b.req('/verify-email', {
    method: 'GET',
    query: { token: lastMail('verify-email', email).token },
  });
  expect(v.status).toBe(200);
  const [u] = await q<{ id: string }>('SELECT id FROM identity.users WHERE email = $1', [email]);
  return { b, userId: u!.id };
}

async function pgCode(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

beforeAll(async () => {
  await q(
    'TRUNCATE identity.users, identity.sessions, identity.accounts, identity.verifications, identity.two_factors, identity.rate_limits, public.membership, public.workspace CASCADE',
  );
});

afterAll(async () => {
  fs.mkdirSync('results', { recursive: true });
  fs.writeFileSync(
    'results/spike-f-results.json',
    JSON.stringify({ executedAt: new Date().toISOString(), betterAuth: '1.7.12', results }, null, 2) + '\n',
  );
  await authDb.$disconnect();
  await appDb.$disconnect();
  await su.end();
});

describe('1. role split keeps identity data out of the tenant role (SEC-01, SEC-05)', () => {
  it('no role is superuser or BYPASSRLS', async () => {
    const rows = await q<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('app_auth','app_user','migrator')",
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.rolsuper && !r.rolbypassrls)).toBe(true);
  });

  it('app_user cannot read any identity table; app_auth cannot read tenant tables', async () => {
    const appPool = new pg.Pool({ connectionString: URL_APP, max: 1 });
    const authPool = new pg.Pool({ connectionString: URL_AUTH, max: 1 });
    const denied: Record<string, string | undefined> = {};
    for (const t of ['users', 'sessions', 'accounts', 'verifications', 'two_factors', 'rate_limits']) {
      denied[`app_user->identity.${t}`] = await pgCode(() =>
        appPool.query(`SELECT 1 FROM identity.${t} LIMIT 1`),
      );
    }
    for (const t of ['workspace', 'membership']) {
      denied[`app_auth->public.${t}`] = await pgCode(() =>
        authPool.query(`SELECT 1 FROM public.${t} LIMIT 1`),
      );
    }
    await appPool.end();
    await authPool.end();
    results.roleSplit = denied;
    expect(Object.values(denied).every((c) => c === '42501')).toBe(true);
  });
});

describe('2. email + password with verified email (FR-AUTH-01)', () => {
  const email = 'alice@example.test';
  const b = browser();

  it('sign-up creates an unverified user, issues no session and sends one verification mail', async () => {
    const r = await b.req('/sign-up/email', { body: { email, password: PASSWORD, name: 'Alice' } });
    expect(r.status).toBe(200);
    expect(b.sessionCookieName()).toBeUndefined();
    const [u] = await q<{ email_verified: boolean }>(
      'SELECT email_verified FROM identity.users WHERE email = $1',
      [email],
    );
    expect(u!.email_verified).toBe(false);
    expect(mail.filter((m) => m.kind === 'verify-email' && m.to === email)).toHaveLength(1);
    const [acc] = await q<{ password: string }>(
      "SELECT a.password FROM identity.accounts a JOIN identity.users u ON u.id = a.user_id WHERE u.email = $1 AND a.provider_id = 'credential'",
      [email],
    );
    expect(acc!.password).not.toContain(PASSWORD);
    results.passwordHashPrefix = acc!.password.slice(0, 12).replace(/[0-9a-f]/g, 'x');
  });

  it('ids are uuid v7', async () => {
    const [u] = await q<{ id: string }>('SELECT id FROM identity.users WHERE email = $1', [email]);
    expect(u!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('password shorter than 12 characters is rejected', async () => {
    const r = await browser().req('/sign-up/email', {
      body: { email: 'short@example.test', password: 'short-pw', name: 'S' },
    });
    expect(r.status).toBe(400);
  });

  it('sign-in before verification is refused', async () => {
    const r = await browser().req('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(r.status).toBe(403);
    expect((r.json as { code?: string }).code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('a tampered verification token is rejected', async () => {
    const token = lastMail('verify-email', email).token;
    const r = await browser().req('/verify-email', {
      method: 'GET',
      query: { token: token.slice(0, -2) + 'xx' },
    });
    expect(r.status).toBe(401);
  });

  it('the real link verifies the email and signs the user in', async () => {
    const r = await b.req('/verify-email', {
      method: 'GET',
      query: { token: lastMail('verify-email', email).token },
    });
    expect(r.status).toBe(200);
    expect(b.sessionCookieName()).toBeDefined();
    const s = await b.req('/get-session', { method: 'GET' });
    expect((s.json as { user: { email: string; emailVerified: boolean } }).user).toMatchObject({
      email,
      emailVerified: true,
    });
  });

  it('replaying the verification link does not create another session', async () => {
    const before = await q<{ n: number }>(
      'SELECT count(*)::int n FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id WHERE u.email = $1',
      [email],
    );
    const attacker = browser();
    const r = await attacker.req('/verify-email', {
      method: 'GET',
      query: { token: lastMail('verify-email', email).token },
    });
    expect(r.status).toBe(200);
    expect(attacker.sessionCookieName()).toBeUndefined();
    const after = await q<{ n: number }>(
      'SELECT count(*)::int n FROM identity.sessions s JOIN identity.users u ON u.id = s.user_id WHERE u.email = $1',
      [email],
    );
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it('email is case-insensitive (citext)', async () => {
    const r = await browser().req('/sign-in/email', {
      body: { email: 'ALICE@Example.TEST', password: PASSWORD },
    });
    expect(r.status).toBe(200);
  });

  it('records what sign-up returns for an already-registered email (enumeration check)', async () => {
    const fresh = await browser().req('/sign-up/email', {
      body: { email: 'fresh@example.test', password: PASSWORD, name: 'F' },
    });
    const dup = await browser().req('/sign-up/email', { body: { email, password: PASSWORD, name: 'Again' } });
    results.signUpEnumeration = {
      newEmail: fresh.status,
      existingEmail: dup.status,
      existingEmailCode: (dup.json as { code?: string } | null)?.code ?? null,
      distinguishable: fresh.status !== dup.status,
    };
    expect([200, 422]).toContain(dup.status);
  });
});

describe('3. session cookies, rotation and log-out-all (FR-AUTH-02)', () => {
  let userId = '';
  let b: Browser;
  const email = 'bob@example.test';

  beforeAll(async () => {
    ({ b, userId } = await verifiedUser(email));
  });

  it('cookie is HttpOnly, SameSite=Lax, Path=/, host-only (no Domain attribute) on http', async () => {
    const r = await browser().req('/sign-in/email', { body: { email, password: PASSWORD } });
    const sc = r.setCookies.find((c) => c.includes('session_token='));
    expect(sc).toBeDefined();
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//i);
    expect(sc).not.toMatch(/Domain=/i);
    results.httpCookie = sc!.replace(/session_token=[^;]+/, 'session_token=<redacted>');
  });

  it('on an https origin the cookie is Secure and __Secure- prefixed', async () => {
    const httpsAuth = makeAuth({ prisma: authDb, mail, audit, baseURL: 'https://app.example.test' });
    const r = await new Browser(httpsAuth, nextIp(), 'https://app.example.test').req('/sign-in/email', {
      body: { email, password: PASSWORD },
    });
    const sc = r.setCookies.find((c) => c.includes('session_token='));
    expect(sc).toMatch(/^__Secure-/);
    expect(sc).toMatch(/;\s*Secure/i);
    expect(sc).not.toMatch(/Domain=/i);
    results.httpsCookie = sc!.replace(/session_token=[^;]+/, 'session_token=<redacted>');
  });

  it('every sign-in issues a fresh token; a planted (fixated) cookie is not adopted', async () => {
    const victim = browser();
    victim.cookies.set('better-auth.session_token', 'attacker-chosen-value');
    const r1 = await victim.req('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(r1.status).toBe(200);
    const t1 = victim.cookies.get('better-auth.session_token');
    expect(t1).toBeDefined();
    expect(t1).not.toBe('attacker-chosen-value');
    const r2 = await browser().req('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(r2.status).toBe(200);
    const tokens = await q<{ token: string }>('SELECT token FROM identity.sessions WHERE user_id = $1', [
      userId,
    ]);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(tokens.length);
  });

  it('records whether session tokens are stored in plain text', async () => {
    const tokens = await q<{ token: string }>('SELECT token FROM identity.sessions WHERE user_id = $1', [
      userId,
    ]);
    const cookie = decodeURIComponent(b.cookies.get('better-auth.session_token')!);
    const rawToken = cookie.split('.')[0]!;
    results.sessionTokenAtRest = tokens.some((t) => t.token === rawToken) ? 'plain' : 'not-plain';
  });

  it('"log out all devices" revokes every session of the user', async () => {
    const other = browser();
    await other.req('/sign-in/email', { body: { email, password: PASSWORD } });
    const n = await q<{ n: number }>('SELECT count(*)::int n FROM identity.sessions WHERE user_id = $1', [
      userId,
    ]);
    expect(n[0]!.n).toBeGreaterThanOrEqual(3);
    const r = await b.req('/revoke-sessions', { body: {} });
    expect(r.status).toBe(200);
    const left = await q<{ n: number }>('SELECT count(*)::int n FROM identity.sessions WHERE user_id = $1', [
      userId,
    ]);
    expect(left[0]!.n).toBe(0);
    const s = await other.req('/get-session', { method: 'GET' });
    expect(s.json).toBeNull();
  });
});

describe('4. generic auth errors and password reset (FR-AUTH-04)', () => {
  const email = 'carol@example.test';
  let userId = '';

  beforeAll(async () => {
    ({ userId } = await verifiedUser(email));
  });

  it('wrong password and unknown account give identical responses', async () => {
    const wrong = await browser().req('/sign-in/email', { body: { email, password: 'wrong-password-123' } });
    const unknown = await browser().req('/sign-in/email', {
      body: { email: 'nobody@example.test', password: 'wrong-password-123' },
    });
    expect(wrong.status).toBe(unknown.status);
    expect(wrong.body).toBe(unknown.body);
    const t = async (e: string) => {
      const s = performance.now();
      await browser().req('/sign-in/email', { body: { email: e, password: 'wrong-password-123' } });
      return performance.now() - s;
    };
    const known: number[] = [];
    const missing: number[] = [];
    for (let i = 0; i < 5; i++) {
      known.push(await t(email));
      missing.push(await t(`nobody${i}@example.test`));
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[2]!;
    results.signInTimingMs = {
      existingMedian: Math.round(med(known)),
      unknownMedian: Math.round(med(missing)),
    };
  });

  it('reset request is identical for known and unknown emails and only mails the known one', async () => {
    const before = mail.length;
    const known = await browser().req('/request-password-reset', { body: { email, redirectTo: '/reset' } });
    const unknown = await browser().req('/request-password-reset', {
      body: { email: 'ghost@example.test', redirectTo: '/reset' },
    });
    expect(known.status).toBe(200);
    expect(known.status).toBe(unknown.status);
    expect(known.body).toBe(unknown.body);
    expect(mail.slice(before).map((m) => m.to)).toEqual([email]);
  });

  it('the reset token is not stored in plain text', async () => {
    const token = lastMail('reset-password', email).token;
    const rows = await q<{ identifier: string; value: string }>(
      'SELECT identifier, value FROM identity.verifications',
    );
    expect(rows.some((r) => r.identifier.includes(token) || r.value.includes(token))).toBe(false);
  });

  it('reset works once, revokes sessions, and the token cannot be reused', async () => {
    const holder = browser();
    await holder.req('/sign-in/email', { body: { email, password: PASSWORD } });
    const token = lastMail('reset-password', email).token;
    const newPassword = 'new-correct-horse-2';
    const r = await browser().req('/reset-password', { body: { token, newPassword } });
    expect(r.status).toBe(200);
    expect((await holder.req('/get-session', { method: 'GET' })).json).toBeNull();
    expect((await browser().req('/sign-in/email', { body: { email, password: PASSWORD } })).status).toBe(401);
    expect((await browser().req('/sign-in/email', { body: { email, password: newPassword } })).status).toBe(
      200,
    );
    const again = await browser().req('/reset-password', {
      body: { token, newPassword: 'third-password-33' },
    });
    expect(again.status).toBe(400);
    void userId;
  });

  it('an expired reset token is refused', async () => {
    await browser().req('/request-password-reset', { body: { email, redirectTo: '/reset' } });
    const token = lastMail('reset-password', email).token;
    await q("UPDATE identity.verifications SET expires_at = now() - interval '1 minute'");
    const r = await browser().req('/reset-password', { body: { token, newPassword: 'expired-token-pw-4' } });
    expect(r.status).toBe(400);
  });
});

describe('5. TOTP MFA (FR-AUTH-03)', () => {
  const email = 'dave@example.test';
  let b: Browser;
  let userId = '';
  let secret = '';

  beforeAll(async () => {
    ({ b, userId } = await verifiedUser(email));
  });

  it('enable requires the password and returns an otpauth URI and backup codes', async () => {
    const bad = await b.req('/two-factor/enable', { body: { password: 'not-the-password-9' } });
    expect(bad.status).toBe(400);
    const r = await b.req('/two-factor/enable', { body: { password: PASSWORD } });
    expect(r.status).toBe(200);
    const body = r.json as { totpURI: string; backupCodes: string[] };
    expect(body.totpURI).toMatch(/^otpauth:\/\/totp\//);
    expect(body.backupCodes.length).toBeGreaterThanOrEqual(8);
    secret = secretFromUri(body.totpURI);
    const [row] = await q<{ secret: string; backup_codes: string }>(
      'SELECT secret, backup_codes FROM identity.two_factors WHERE user_id = $1',
      [userId],
    );
    expect(row!.secret).not.toContain(secret);
    expect(body.backupCodes.some((c) => row!.backup_codes.includes(c))).toBe(false);
  });

  it('2FA is not active until a valid code is confirmed', async () => {
    const [u] = await q<{ two_factor_enabled: boolean }>(
      'SELECT two_factor_enabled FROM identity.users WHERE id = $1',
      [userId],
    );
    expect(u!.two_factor_enabled).toBe(false);
    const r = await b.req('/two-factor/verify-totp', { body: { code: totp(secret) } });
    expect(r.status).toBe(200);
    const [v] = await q<{ two_factor_enabled: boolean }>(
      'SELECT two_factor_enabled FROM identity.users WHERE id = $1',
      [userId],
    );
    expect(v!.two_factor_enabled).toBe(true);
  });

  it('password sign-in now yields a 2FA challenge, not a session; a valid code completes it', async () => {
    const c = browser();
    const r = await c.req('/sign-in/email', { body: { email, password: PASSWORD } });
    expect(r.status).toBe(200);
    expect((r.json as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect(c.sessionCookieName()).toBeUndefined();
    const v = await c.req('/two-factor/verify-totp', { body: { code: totp(secret) } });
    expect(v.status).toBe(200);
    expect(c.sessionCookieName()).toBeDefined();
  });

  it('repeated wrong codes lock the factor; even a correct code is then refused', async () => {
    const c = browser();
    await c.req('/sign-in/email', { body: { email, password: PASSWORD } });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await c.req('/two-factor/verify-totp', { body: { code: '000000' } })).status);
    }
    const locked = await c.req('/two-factor/verify-totp', { body: { code: totp(secret) } });
    const [row] = await q<{ failed_verification_count: number; locked_until: Date | null }>(
      'SELECT failed_verification_count, locked_until FROM identity.two_factors WHERE user_id = $1',
      [userId],
    );
    results.totpLockout = {
      wrongCodeStatuses: statuses,
      afterLockStatus: locked.status,
      lockedUntilSet: !!row!.locked_until,
    };
    expect(locked.status).not.toBe(200);
    expect(c.sessionCookieName()).toBeUndefined();
    expect(row!.locked_until).not.toBeNull();
  });
});

describe('6. rate limiting on auth endpoints (FR-AUTH-07)', () => {
  it('the 6th sign-in from one IP within the window gets 429; another IP is unaffected', async () => {
    const attacker = browser();
    const statuses: number[] = [];
    let retryAfter: string | null = null;
    for (let i = 0; i < 6; i++) {
      const r = await attacker.req('/sign-in/email', {
        body: { email: 'eve@example.test', password: 'guess-guess-123' },
      });
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers.get('x-retry-after');
    }
    const other = await browser().req('/sign-in/email', {
      body: { email: 'eve@example.test', password: 'guess-guess-123' },
    });
    results.rateLimit = { statuses, retryAfter, otherIpStatus: other.status };
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
    expect(other.status).toBe(401);
    const rows = await q<{ n: number }>('SELECT count(*)::int n FROM identity.rate_limits');
    expect(rows[0]!.n).toBeGreaterThan(0);
  });
});

describe('7. Google OAuth start and callback validation (FR-AUTH-01, offline half)', () => {
  it('sign-in/social returns a Google authorization URL with state and PKCE S256', async () => {
    const b = browser();
    const r = await b.req('/sign-in/social', { body: { provider: 'google', callbackURL: '/' } });
    expect(r.status).toBe(200);
    const u = new URL((r.json as { url: string }).url);
    expect(u.hostname).toBe('accounts.google.com');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/api/auth/callback/google');
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('scope')).toContain('openid');
    results.googleAuthorizeParams = [...u.searchParams.keys()].sort();
  });

  it('a callback with a forged state is rejected and creates no user', async () => {
    const before = await q<{ n: number }>('SELECT count(*)::int n FROM identity.users');
    const b = browser();
    await b.req('/sign-in/social', { body: { provider: 'google', callbackURL: '/' } });
    const r = await b.req('/callback/google', {
      method: 'GET',
      query: { code: 'fake-code', state: 'forged-state' },
    });
    expect(r.status).toBeGreaterThanOrEqual(300);
    expect(r.headers.get('location') ?? '').toMatch(/error/i);
    const after = await q<{ n: number }>('SELECT count(*)::int n FROM identity.users');
    expect(after[0]!.n).toBe(before[0]!.n);
    results.forgedStateRedirect = r.headers.get('location');
  });
});

describe('8. session -> membership -> workspace bridge under RLS (FR-AUTH-08, SEC-01)', () => {
  const W1 = uuidv7();
  const W2 = uuidv7();
  let alice = '';
  let erin = '';
  let erinBrowser: Browser;

  const asWorkspace = <T>(
    ws: string,
    fn: (tx: Parameters<Parameters<typeof appDb.$transaction>[0]>[0]) => Promise<T>,
  ) =>
    appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.workspace_id', ${ws}, TRUE)`;
      return fn(tx);
    });
  const asActor = <T>(
    userId: string,
    fn: (tx: Parameters<Parameters<typeof appDb.$transaction>[0]>[0]) => Promise<T>,
  ) =>
    appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId}, TRUE)`;
      return fn(tx);
    });

  beforeAll(async () => {
    const [a] = await q<{ id: string }>("SELECT id FROM identity.users WHERE email = 'alice@example.test'");
    alice = a!.id;
    ({ b: erinBrowser, userId: erin } = await verifiedUser('erin@example.test'));
    await asWorkspace(W1, async (tx) => {
      await tx.workspace.create({ data: { id: W1, name: 'Alice Agency' } });
      await tx.membership.create({ data: { workspaceId: W1, userId: alice, role: 'owner' } });
      await tx.membership.create({ data: { workspaceId: W1, userId: erin, role: 'viewer' } });
    });
    await asWorkspace(W2, async (tx) => {
      await tx.workspace.create({ data: { id: W2, name: 'Erin Studio' } });
      await tx.membership.create({ data: { workspaceId: W2, userId: erin, role: 'owner' } });
    });
  });

  it('the actor derived from the session sees only their own memberships', async () => {
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: [...erinBrowser.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }),
    });
    expect(session?.user.id).toBe(erin);
    const mine = await asActor(session!.user.id, (tx) =>
      tx.membership.findMany({ orderBy: { role: 'asc' } }),
    );
    expect(mine.map((m) => [m.workspaceId, m.role]).sort()).toEqual(
      [
        [W1, 'viewer'],
        [W2, 'owner'],
      ].sort(),
    );
    const aliceView = await asActor(alice, (tx) => tx.membership.findMany());
    expect(aliceView.map((m) => m.userId)).toEqual([alice]);
  });

  it('no context returns zero rows on every tenant table, also on re-used pooled connections', async () => {
    const counts: number[] = [];
    for (let i = 0; i < 10; i++) {
      counts.push(await appDb.membership.count(), await appDb.workspace.count());
    }
    expect(counts.every((c) => c === 0)).toBe(true);
  });

  it('actor context alone cannot write memberships (no self-promotion)', async () => {
    const code = await asActor(erin, (tx) =>
      tx.membership.create({ data: { workspaceId: W1, userId: erin, role: 'admin' } }),
    ).then(
      () => 'created',
      (e: { code?: string; meta?: unknown; message?: string }) => e.code ?? e.message ?? 'error',
    );
    expect(code).not.toBe('created');
    const rows = await q<{ n: number }>("SELECT count(*)::int n FROM public.membership WHERE role = 'admin'");
    expect(rows[0]!.n).toBe(0);
  });

  it('workspace context of W2 cannot see or modify W1 memberships', async () => {
    const seen = await asWorkspace(W2, (tx) => tx.membership.findMany());
    expect(seen.every((m) => m.workspaceId === W2)).toBe(true);
    const updated = await asWorkspace(W2, (tx) =>
      tx.membership.updateMany({ where: { workspaceId: W1 }, data: { role: 'owner' } }),
    );
    expect(updated.count).toBe(0);
  });
});

describe('9. concurrency through the transaction pooler (Spike B B-3 applied to auth)', () => {
  it('40 concurrent sign-ins and 120 concurrent session reads: no errors, no cross-user sessions', async () => {
    const emails = Array.from({ length: 4 }, (_, i) => `load${i}@example.test`);
    const users = await Promise.all(emails.map((e) => verifiedUser(e)));
    const t0 = performance.now();
    const signIns = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const email = emails[i % emails.length]!;
        const b = browser();
        const r = await b.req('/sign-in/email', { body: { email, password: PASSWORD } });
        return { r, b, email };
      }),
    );
    const reads = await Promise.all(
      Array.from({ length: 120 }, async (_, i) => {
        const s = signIns[i % signIns.length]!;
        const r = await s.b.req('/get-session', { method: 'GET' });
        return { expected: s.email, got: (r.json as { user?: { email: string } } | null)?.user?.email };
      }),
    );
    const ms = Math.round(performance.now() - t0);
    const signInErrors = signIns.filter((s) => s.r.status !== 200).length;
    const mismatches = reads.filter((r) => r.expected !== r.got).length;
    results.concurrency = {
      signIns: 40,
      sessionReads: 120,
      signInErrors,
      mismatches,
      totalMs: ms,
      poolSize: 2,
    };
    expect(users).toHaveLength(4);
    expect(signInErrors).toBe(0);
    expect(mismatches).toBe(0);
  });
});

describe('11. Next 16 route handler and CSRF/origin protection (ADR-006, SEC-03)', () => {
  const signIn = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
    auth.handler(
      new Request('http://localhost:3000/api/auth/sign-in/email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
        body: JSON.stringify({ email: 'alice@example.test', password: PASSWORD, ...body }),
      }),
    );

  it('toNextJsHandler exposes GET/POST that serve the auth API', async () => {
    const { toNextJsHandler } = await import('better-auth/next-js');
    const { GET } = toNextJsHandler(auth);
    const ok = await GET(new Request('http://localhost:3000/api/auth/ok'));
    expect(ok.status).toBe(200);
  });

  it('origin protection is active even under the test runner', async () => {
    const statuses = {
      untrustedOriginNoCookie: (await signIn({ origin: 'https://evil.example' })).status,
      untrustedOriginWithCookie: (await signIn({ origin: 'https://evil.example', cookie: 'x=1' })).status,
      crossSiteNavigation: (
        await signIn({
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        })
      ).status,
      openRedirectCallback: (
        await signIn({ origin: 'http://localhost:3000' }, { callbackURL: 'https://evil.example/x' })
      ).status,
      trustedOrigin: (await signIn({ origin: 'http://localhost:3000' })).status,
    };
    results.csrf = statuses;
    expect(statuses).toEqual({
      untrustedOriginNoCookie: 403,
      untrustedOriginWithCookie: 403,
      crossSiteNavigation: 403,
      openRedirectCallback: 403,
      trustedOrigin: 200,
    });
  });
});

describe('10. audit hook coverage (FR-AUD-01 integration point)', () => {
  it('user creation, session creation and session revocation each emitted an audit event', () => {
    const actions = new Set(audit.map((a) => a.action));
    results.auditActions = [...actions].sort();
    results.auditEventCount = audit.length;
    expect(actions.has('auth.user.created')).toBe(true);
    expect(actions.has('auth.session.created')).toBe(true);
    expect(actions.has('auth.session.revoked')).toBe(true);
  });
});
