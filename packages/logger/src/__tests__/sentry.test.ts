import { describe, expect, it } from 'vitest';
import { checkSentryDsn, scrubSentryEvent } from '../sentry';

describe('checkSentryDsn (SEC-21: EU region only)', () => {
  it('accepts an EU ingest DSN', () => {
    const dsn = 'https://abc123@o1.ingest.de.sentry.io/42';
    expect(checkSentryDsn(dsn)).toEqual({ ok: true, dsn });
  });

  it('disables reporting for an unset, malformed, insecure or non-EU DSN', () => {
    expect(checkSentryDsn(undefined)).toEqual({ ok: false, reason: 'unset' });
    expect(checkSentryDsn('  ')).toEqual({ ok: false, reason: 'unset' });
    expect(checkSentryDsn('not a url')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkSentryDsn('http://abc@o1.ingest.de.sentry.io/42')).toEqual({ ok: false, reason: 'invalid' });
    expect(checkSentryDsn('https://abc@o1.ingest.us.sentry.io/42')).toEqual({ ok: false, reason: 'not_eu' });
    expect(checkSentryDsn('https://abc@o1.ingest.sentry.io/42')).toEqual({ ok: false, reason: 'not_eu' });
    expect(checkSentryDsn('https://abc@evil.example/de.sentry.io')).toEqual({ ok: false, reason: 'not_eu' });
  });
});

describe('scrubSentryEvent (FR-OBS-01, SEC-05)', () => {
  const event = {
    user: { id: 'user-1', email: 'asha@example.com', ip_address: '203.0.113.7', username: 'asha' },
    server_name: 'host-1',
    message: 'failed for asha@example.com',
    request: {
      url: 'https://app.example/reset-password?token=abc.def&email=asha@example.com#frag',
      headers: { cookie: 'session=secret', authorization: 'Bearer x' },
      cookies: { session: 'secret' },
      data: { password: 'hunter2-hunter2' },
      query_string: 'token=abc',
    },
    exception: { values: [{ type: 'Error', value: 'cannot reach 9876543210 for asha@example.com' }] },
    breadcrumbs: [{ message: 'sent to asha@example.com', data: { email: 'asha@example.com', url: '/x' } }],
    extra: { password: 'hunter2-hunter2', workspaceId: 'ws-1' },
    contexts: { custom: { api_key: 'sk_live_abcdefghijklmnop' } },
    tags: { app: 'dashboard' },
  };

  it('keeps only the user id and drops host, headers, cookies, body and query', () => {
    const out = scrubSentryEvent(event);
    expect(out.user).toEqual({ id: 'user-1' });
    expect(out.server_name).toBeUndefined();
    expect(out.request).toEqual({ url: 'https://app.example/reset-password' });
  });

  it('redacts free text, breadcrumbs and extra data', () => {
    const json = JSON.stringify(scrubSentryEvent(event));
    expect(json).not.toContain('asha@example.com');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('secret');
    expect(json).not.toContain('sk_live');
    expect(json).toContain('ws-1');
    expect(json).toContain('dashboard');
  });

  it('removes a user without a string id and does not mutate its input', () => {
    const copy = structuredClone(event);
    expect(scrubSentryEvent({ user: { email: 'a@b.test' } }).user).toBeUndefined();
    scrubSentryEvent(event);
    expect(event).toEqual(copy);
  });
});

describe('SENTRY_DATA_COLLECTION', () => {
  it('turns every collection switch off', async () => {
    const { SENTRY_DATA_COLLECTION: c } = await import('../sentry');
    expect(c.userInfo).toBe(false);
    expect(c.cookies).toBe(false);
    expect(c.httpHeaders).toBe(false);
    expect(c.httpBodies).toEqual([]);
    expect(c.urlQueryParams).toBe(false);
    expect(c.databaseQueryData).toBe(false);
    expect(c.stackFrameVariables).toBe(false);
    expect(c.genAI).toEqual({ inputs: false, outputs: false });
    expect(c.graphQL).toEqual({ document: false, variables: false });
  });
});

describe('scrubSentryEvent trace contexts', () => {
  it('keeps trace and span ids intact while redacting other contexts', () => {
    const out = scrubSentryEvent({
      contexts: {
        trace: { trace_id: 'e89d96b0b8be4340aff17ad1fbd20b5b', span_id: '1234567890123456' },
        x: { n: 'a@b.test' },
      },
    });
    expect(out.contexts).toMatchObject({ trace: { span_id: '1234567890123456' } });
    expect(JSON.stringify(out)).not.toContain('a@b.test');
  });
});
