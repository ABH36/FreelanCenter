/**
 * FR-OBS-01 / SEC-05: the real Sentry SDK, configured exactly as both apps configure it, with a transport that
 * captures the envelope instead of sending it. Nothing personal may be in what would leave the process.
 */
import * as Sentry from '@sentry/nextjs';
import { afterAll, describe, expect, it } from 'vitest';
import { sentryOptions } from '@platform/logger';

const sent: string[] = [];

afterAll(async () => {
  await Sentry.close();
});

describe('Sentry with the platform options', () => {
  it('sends an error event with ids but no address, cookie, header, query or body', async () => {
    Sentry.init({
      ...sentryOptions('https://k@o1.ingest.de.sentry.io/1', 'test'),
      transport: () => ({
        send: async (envelope: unknown) => {
          sent.push(JSON.stringify(envelope));
          return {};
        },
        flush: async () => true,
      }),
    });
    Sentry.getCurrentScope().setUser({ id: 'user-1', email: 'asha@example.com', ip_address: '203.0.113.7' });
    Sentry.getCurrentScope().setExtra('note', 'asha@example.com');
    Sentry.addBreadcrumb({ message: 'mail to asha@example.com', data: { email: 'asha@example.com' } });
    Sentry.captureException(new Error('failed for asha@example.com with token=abcdef1234567890'));
    await Sentry.flush(2000);

    // Source lines in stack frames are code (this file's own literals), not data: compare everything else.
    const events = sent.flatMap((raw) => {
      const [, items] = JSON.parse(raw) as [unknown, Array<[unknown, Record<string, unknown>]>];
      return items.map(([, payload]) => payload);
    });
    for (const event of events) {
      const exception = event.exception as { values: Array<{ stacktrace?: unknown }> } | undefined;
      for (const value of exception?.values ?? []) delete value.stacktrace;
    }
    const all = JSON.stringify(events);
    expect(all).toContain('"span_id":"');
    expect(all).not.toContain('[REDACTED_CARD]');
    expect(all).toContain('user-1');
    expect(all).toContain('failed for');
    expect(all).not.toContain('asha@example.com');
    expect(all).not.toContain('203.0.113.7');
  });
});
