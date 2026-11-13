import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@platform/logger';

let requestHeaders: Headers | null = null;
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  headers: async () => {
    if (!requestHeaders) throw new Error('outside a request');
    return requestHeaders;
  },
}));

const { instrument, perfRequestId, timed } = await import('./perf');

function fakeLogger() {
  const info = vi.fn();
  return { logger: { info } as unknown as Logger, info };
}

beforeEach(() => {
  requestHeaders = null;
});

describe('DG-28 server-side timing', () => {
  it('accepts only short measurement ids of letters, digits and dashes', () => {
    expect(perfRequestId('run1-0001-abcd')).toBe('run1-0001-abcd');
    expect(perfRequestId(null)).toBeNull();
    expect(perfRequestId('short')).toBeNull();
    expect(perfRequestId('a'.repeat(65))).toBeNull();
    expect(perfRequestId('run1\n{"level":"fatal"}')).toBeNull();
  });

  it('logs nothing for a request without the header, or outside a request', async () => {
    const { logger, info } = fakeLogger();
    await timed(logger, 'op', async () => 1);
    requestHeaders = new Headers();
    await timed(logger, 'op', async () => 1);
    expect(info).not.toHaveBeenCalled();
  });

  it('logs the operation and its time, and nothing else, for a measured request', async () => {
    const { logger, info } = fakeLogger();
    requestHeaders = new Headers({ 'x-perf-request': 'run1-0001-abcd' });
    expect(await timed(logger, 'auth.getSession', async () => 'value')).toBe('value');
    expect(info).toHaveBeenCalledOnce();
    const [message, data] = info.mock.calls[0]!;
    expect(message).toBe('perf.server');
    expect(Object.keys(data).sort()).toEqual(['ms', 'op', 'perfRequest', 'startedAt']);
    expect(data).toMatchObject({ perfRequest: 'run1-0001-abcd', op: 'auth.getSession' });
  });

  it('times a failed call too and rethrows its error', async () => {
    const { logger, info } = fakeLogger();
    requestHeaders = new Headers({ 'x-perf-request': 'run1-0001-abcd' });
    await expect(timed(logger, 'op', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(info).toHaveBeenCalledOnce();
  });

  it('instrument times async methods, keeps sync methods synchronous and keeps `this`', async () => {
    const { logger, info } = fakeLogger();
    requestHeaders = new Headers({ 'x-perf-request': 'run1-0001-abcd' });
    const service = instrument(logger, 'projects', {
      base: 40,
      async list(n: number) {
        return this.base + n;
      },
      label() {
        return `base ${this.base}`;
      },
    });
    expect(service.label()).toBe('base 40');
    expect(await service.list(2)).toBe(42);
    expect(service.base).toBe(40);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0]![1]).toMatchObject({ op: 'projects.list' });
  });
});
