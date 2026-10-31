import { X509Certificate, createHash, createHmac, pbkdf2Sync } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { onceUntilSuccess } from './client';
import { PINNED_CAS, connectionConfig } from './connection';
import { assertUrlRole, isLocalHost, parseDotEnv, passwordOf, resolveDatabaseUrl, roleOf } from './env';
import { DbBusyError } from './errors';
import { TransactionLimiter } from './limiter';
import { scramSha256Verifier } from './scram';
import { isUuid, uuidv7 } from './uuid';

describe('onceUntilSuccess (S8-9)', () => {
  it('runs the check lazily and only once after a success, also for concurrent callers', async () => {
    const check = vi.fn(async () => undefined);
    const ready = onceUntilSuccess(check);
    expect(check).not.toHaveBeenCalled();
    await Promise.all([ready(), ready()]);
    await ready();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a failure is reported and forgotten: the next call runs the check again', async () => {
    const failures: unknown[] = [];
    const down = new Error('EAUTHTIMEOUT');
    const check = vi.fn<() => Promise<void>>().mockRejectedValueOnce(down).mockResolvedValue(undefined);
    const ready = onceUntilSuccess(check, (e) => failures.push(e));
    await expect(ready()).rejects.toBe(down);
    expect(failures).toEqual([down]);
    await expect(ready()).resolves.toBeUndefined();
    await ready();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('a permanent failure (a wrong role) fails every call', async () => {
    const check = vi.fn(async () => {
      throw new Error('database connection must use role app_user');
    });
    const ready = onceUntilSuccess(check);
    await expect(ready()).rejects.toThrow('app_user');
    await expect(ready()).rejects.toThrow('app_user');
    expect(check).toHaveBeenCalledTimes(2);
  });
});

describe('uuidv7', () => {
  it('produces RFC 9562 version-7 ids that embed the timestamp', () => {
    const at = Date.UTC(2026, 9, 22, 12, 0, 0);
    const id = uuidv7(at);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(at);
  });

  it('sorts by creation time and does not repeat', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => uuidv7(1_700_000_000_000 + i));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('isUuid accepts RFC ids and rejects everything else', () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    for (const bad of ['', 'abc', "1'; DROP TABLE x; --", '11111111-1111-0111-8111-111111111111', 42, null]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe('env conventions', () => {
  it('parses .env lines, quotes and trailing comments', () => {
    const env = parseDotEnv('A=1\n# c\nB="x y"\nC=\'q\'\nD=v # note\n bad line\nE=');
    expect(env).toEqual({ A: '1', B: 'x y', C: 'q', D: 'v', E: '' });
  });

  it('derives the role from Supabase pooler user names', () => {
    expect(roleOf('postgresql://app_user.abcdef@host:6543/postgres')).toBe('app_user');
    expect(roleOf('postgresql://migrator@127.0.0.1:55440/platform')).toBe('migrator');
    expect(passwordOf('postgresql://u:p%40ss@h/db')).toBe('p@ss');
  });

  it('rejects a URL that authenticates as the wrong role', () => {
    expect(() => assertUrlRole('app', 'postgresql://postgres.ref:pw@h:6543/postgres')).toThrow(
      'DATABASE_URL must authenticate as app_user, found postgres',
    );
    expect(() => assertUrlRole('app', 'postgresql://app_user.ref:pw@h:6543/postgres')).not.toThrow();
  });

  it('never falls back to local URLs for the env target', () => {
    expect(() => resolveDatabaseUrl('app', 'env', {})).toThrow('DATABASE_URL is not set');
    expect(resolveDatabaseUrl('app', 'env', { DATABASE_URL: 'postgresql://x@h/d' })).toBe(
      'postgresql://x@h/d',
    );
    expect(isLocalHost(resolveDatabaseUrl('app', 'local', {}))).toBe(true);
  });
});

describe('connectionConfig', () => {
  it('uses plain TCP for the local stack only', () => {
    expect(connectionConfig('postgresql://app_user@127.0.0.1:56440/platform')).toEqual({
      connectionString: 'postgresql://app_user@127.0.0.1:56440/platform',
    });
  });

  it('refuses a remote URL without TLS settings', () => {
    expect(() => connectionConfig('postgresql://u:p@db.example.com/x', {})).toThrow(/sslmode/);
    expect(connectionConfig('postgresql://u:p@db.example.com/x?sslmode=verify-full', {})).toEqual({
      connectionString: 'postgresql://u:p@db.example.com/x?sslmode=verify-full',
    });
  });

  it('the bundled Supabase CA is the one the Owner confirmed (fingerprint pinned)', () => {
    const cert = new X509Certificate(PINNED_CAS['supabase-root-2021']!);
    expect(cert.fingerprint256).toBe(
      '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA',
    );
    expect(cert.subject).toContain('CN=Supabase Root 2021 CA');
  });

  it('a pinned CA name verifies the server certificate against that CA, with sslmode removed', () => {
    const config = connectionConfig('postgresql://u:p@pooler.supabase.com:6543/postgres?sslmode=require', {
      DATABASE_SSL_ROOT_CERT: 'supabase-root-2021',
    });
    expect(config).toEqual({
      connectionString: 'postgresql://u:p@pooler.supabase.com:6543/postgres',
      ssl: { ca: PINNED_CAS['supabase-root-2021'], rejectUnauthorized: true },
    });
  });
});

describe('scramSha256Verifier', () => {
  it('matches an independent RFC 5802 derivation', () => {
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');
    const salted = pbkdf2Sync('pencil', salt, 4096, 32, 'sha256');
    const stored = createHash('sha256')
      .update(createHmac('sha256', salted).update('Client Key').digest())
      .digest('base64');
    const server = createHmac('sha256', salted).update('Server Key').digest('base64');
    expect(scramSha256Verifier('pencil', salt)).toBe(
      `SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$${stored}:${server}`,
    );
  });

  it('matches the server key published in RFC 7677', () => {
    // RFC 7677 section 3: ServerSignature for this exchange is derived from this ServerKey.
    const v = scramSha256Verifier('pencil', Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64'));
    const serverKey = Buffer.from(v.split(':').at(-1)!, 'base64');
    const authMessage =
      'n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,' +
      's=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0';
    const signature = createHmac('sha256', serverKey).update(authMessage).digest('base64');
    expect(signature).toBe('6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
  });

  it('uses a fresh salt each time and rejects non-ASCII passwords', () => {
    expect(scramSha256Verifier('x'.repeat(32))).not.toBe(scramSha256Verifier('x'.repeat(32)));
    expect(() => scramSha256Verifier('pass word')).toThrow(/printable ASCII/);
  });
});

describe('TransactionLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('never runs more than `concurrency` tasks and preserves FIFO order', async () => {
    const limiter = new TransactionLimiter({ concurrency: 2, maxQueue: 100, queueTimeoutMs: 1000 });
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limiter.run(async () => {
          running++;
          peak = Math.max(peak, running);
          await new Promise((r) => setTimeout(r, 2));
          order.push(i);
          running--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(limiter.stats).toEqual({ active: 0, queued: 0 });
  });

  it('rejects immediately when the queue is full and releases slots after failures', async () => {
    const limiter = new TransactionLimiter({ concurrency: 1, maxQueue: 1, queueTimeoutMs: 1000 });
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((r) => (release = r)));
    const second = limiter.run(async () => 'second');
    await expect(limiter.run(async () => 'third')).rejects.toBeInstanceOf(DbBusyError);
    release();
    await first;
    await expect(second).resolves.toBe('second');
    await expect(limiter.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.run(async () => 'after')).resolves.toBe('after');
  });

  it('times out queued callers', async () => {
    vi.useFakeTimers();
    const limiter = new TransactionLimiter({ concurrency: 1, maxQueue: 10, queueTimeoutMs: 50 });
    const blocker = limiter.run(() => new Promise<void>(() => undefined));
    const waiting = limiter.run(async () => 'never');
    vi.advanceTimersByTime(51);
    await expect(waiting).rejects.toBeInstanceOf(DbBusyError);
    expect(limiter.stats).toEqual({ active: 1, queued: 0 });
    void blocker;
  });

  it('rejects a zero concurrency', () => {
    expect(() => new TransactionLimiter({ concurrency: 0, maxQueue: 1, queueTimeoutMs: 1 })).toThrow(
      RangeError,
    );
  });
});
