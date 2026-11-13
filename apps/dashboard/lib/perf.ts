/**
 * NFR-PERF-04 in region (DG-28, P3 S0): server-side timing of the work a dashboard request does (session lookup,
 * workspace resolution and every service call), logged only for requests that carry a measurement id in
 * `x-perf-request`. Next 16 sends App Router page headers before rendering ends, so a `Server-Timing` header cannot
 * carry this; the measurement script reads these log lines instead and takes, per request, the span from the first
 * call's start to the last call's end. The log line holds the operation name and times only: no ids, no data.
 * Without the header nothing is logged, so normal traffic is unaffected.
 */
import 'server-only';
import { headers } from 'next/headers';
import type { Logger } from '@platform/logger';

/** A measurement id from the client: letters, digits and dashes only, so it can never inject into a log line. */
const PERF_ID = /^[A-Za-z0-9-]{8,64}$/;
export const PERF_HEADER = 'x-perf-request';

export function perfRequestId(value: string | null | undefined): string | null {
  return value && PERF_ID.test(value) ? value : null;
}

async function currentPerfId(): Promise<string | null> {
  try {
    return perfRequestId((await headers()).get(PERF_HEADER));
  } catch {
    // Outside a request (an after() task, a job): nothing to measure.
    return null;
  }
}

async function record(logger: Logger, op: string, startedAt: number, start: number): Promise<void> {
  const id = await currentPerfId();
  if (!id) return;
  const ms = Math.round((performance.now() - start) * 10) / 10;
  logger.info('perf.server', { perfRequest: id, op, startedAt, ms });
}

/** Times `fn` when the request carries a measurement id; otherwise only runs it. */
export async function timed<T>(logger: Logger, op: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    await record(logger, op, startedAt, start);
  }
}

/**
 * Wraps every method of a service so each asynchronous call is timed as `<name>.<method>`. A method that returns a
 * plain value is passed through unchanged (it stays synchronous).
 */
export function instrument<S extends object>(logger: Logger, name: string, service: S): S {
  return new Proxy(service, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        const startedAt = Date.now();
        const start = performance.now();
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.finally(() => record(logger, `${name}.${prop}`, startedAt, start));
      };
    },
  });
}
