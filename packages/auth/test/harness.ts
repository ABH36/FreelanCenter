/**
 * Product auth suite harness: real Better Auth handler (what `toNextJsHandler` mounts), the local Docker
 * database through PgBouncer as `app_auth`, a capture mail sink and a cookie-jar browser.
 */
import { randomInt } from 'node:crypto';
import pg from 'pg';
import { createAuthPrismaClient } from '@platform/db';
import { LOCAL_DATABASE_URLS } from '@platform/db/testing';
import { createCaptureProvider } from '@platform/providers';
import { type AuditWriter, type AuthAuditEvent, type RawQueryClient, createAuditWriter } from '../src/audit';
import { type Auth, type AuthPrismaClient, createAuth } from '../src/auth';
import { type AuthConfig, TURNSTILE_TEST_KEYS } from '../src/config';

export const PASSWORD = 'correct-horse-battery-1';
export const ORIGIN = 'http://localhost:3000';
/** The production header (Vercel). Tests prove a client-settable header cannot stand in for it. */
export const IP_HEADER = 'x-vercel-forwarded-for';
/** Unique per run: identity rows and rate-limit counters persist between runs on the same database. */
export const RUN = `${Date.now().toString(36)}${randomInt(1e6).toString(36)}`;

/**
 * Assertions on identity rows run as app_auth (the only role with access to the `identity` schema). Platform
 * audit rows are readable by no role at all until the S8 admin read path exists, so audit assertions use the
 * real writer and check the row id it returns (`recordedAudit`).
 */
export const admin = new pg.Pool({ connectionString: LOCAL_DATABASE_URLS.auth, max: 3 });
export const authPrisma = createAuthPrismaClient({ connectionString: LOCAL_DATABASE_URLS.auth, poolMax: 5 });

export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await admin.query(sql, params)).rows as T[];
}

export interface RecordedAudit extends AuthAuditEvent {
  /** The `app.audit_logs` id returned by `app.record_platform_audit`; null means the insert failed. */
  id: string | null;
}

/** Every audit event written in this test file, through the real definer function. */
export const recordedAudit: RecordedAudit[] = [];
const realAudit = createAuditWriter(authPrisma as unknown as RawQueryClient);
const spyAudit: AuditWriter = {
  async record(event) {
    const id = await realAudit.record(event);
    recordedAudit.push({ ...event, id });
    return id;
  },
};

export function testConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    baseURL: ORIGIN,
    secret: 'product-auth-suite-local-only-secret-0123456789',
    appName: 'Platform',
    clientIpHeader: IP_HEADER,
    turnstileSecretKey: TURNSTILE_TEST_KEYS.secretPass,
    google: { clientId: 'suite-fake-client.apps.googleusercontent.com', clientSecret: 'suite-fake-secret' },
    email: { transport: 'capture' },
    ...overrides,
  };
}

/** An auth instance whose deferred mail sends can be awaited. */
export function makeAuth(overrides: Partial<AuthConfig> = {}) {
  const mail = createCaptureProvider();
  const pending: Promise<void>[] = [];
  const auth = createAuth({
    config: testConfig(overrides),
    prisma: authPrisma as unknown as AuthPrismaClient,
    email: mail,
    audit: spyAudit,
    defer: (task) => void pending.push(task()),
  });
  const flush = async () => {
    await Promise.all(pending.splice(0));
  };
  return { auth, mail, flush };
}

let ipSeq = randomInt(1, 200) * 250;
/** Unique documentation-range-free private IPs per browser and per run. */
export function nextIp(): string {
  const n = ipSeq++;
  return `10.${Math.floor(n / 250) % 250}.${(n % 250) + 1}.${randomInt(1, 254)}`;
}

export interface Res {
  status: number;
  json: unknown;
  body: string;
  headers: Headers;
  setCookies: string[];
}

export class Browser {
  readonly cookies = new Map<string, string>();

  constructor(
    private readonly auth: Auth,
    readonly ip = nextIp(),
    private readonly origin = ORIGIN,
  ) {}

  async req(
    path: string,
    opts: {
      method?: 'GET' | 'POST';
      body?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      /** Turnstile response; defaults to Cloudflare's dummy token, `null` omits the header. */
      captcha?: string | null;
    } = {},
  ): Promise<Res> {
    const url = new URL(`/api/auth${path}`, this.origin);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const headers = new Headers({ origin: this.origin, [IP_HEADER]: this.ip, 'user-agent': 'auth-suite' });
    if (opts.captcha !== null)
      headers.set('x-captcha-response', opts.captcha ?? TURNSTILE_TEST_KEYS.dummyToken);
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    if (this.cookies.size) headers.set('cookie', this.cookieHeader());
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
    const res = await this.auth.handler(
      new Request(url, {
        method: opts.method ?? 'POST',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        redirect: 'manual',
      }),
    );
    const setCookies = res.headers.getSetCookie();
    for (const sc of setCookies) {
      const [pair = ''] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!value || /max-age=0/i.test(sc)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const body = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      json = null;
    }
    return { status: res.status, json, body, headers: res.headers, setCookies };
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  sessionCookieName(): string | undefined {
    return [...this.cookies.keys()].find((k) => k.endsWith('session_token'));
  }
}

/** The link in the newest captured mail of `kind` to `to`, and its token. */
export function lastLink(
  mail: ReturnType<typeof createCaptureProvider>,
  kind: 'auth.verify_email' | 'auth.reset_password',
  to: string,
): { url: URL; token: string } {
  const m = [...mail.sent].reverse().find((x) => x.kind === kind && x.to === to);
  if (!m) throw new Error(`no ${kind} mail for ${to}`);
  const href = /https?:\/\/\S+/.exec(m.text)?.[0];
  if (!href) throw new Error('mail has no link');
  const url = new URL(href);
  const token = kind === 'auth.verify_email' ? url.searchParams.get('token') : url.pathname.split('/').pop();
  if (!token) throw new Error('link has no token');
  return { url, token };
}

export function email(label: string): string {
  return `${label}.${RUN}@example.test`;
}

/** Audit events of this file, filtered; each one must have been inserted (non-null row id). */
export function auditRows(where: { actorId?: string; action?: string } = {}) {
  const rows = recordedAudit.filter(
    (a) =>
      (where.actorId === undefined || a.actorUserId === where.actorId) &&
      (where.action === undefined || a.action === where.action),
  );
  const failed = rows.filter((r) => r.id === null);
  if (failed.length) throw new Error(`audit insert failed for ${failed.map((f) => f.action).join(', ')}`);
  return rows;
}
