/**
 * @platform/logger - Context and Correlation ID management
 * Server-side correlation ID generation, sanitization, and propagation via AsyncLocalStorage.
 * Satisfies FR-OBS-01, SEC-05, and Cross-Module Observability contract.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface LogContext {
  correlationId: string;
  workspaceId?: string;
  projectId?: string;
  userId?: string;
  app?: string;
  deploymentSurface?: string;
  [key: string]: unknown;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

/**
 * Valid correlation ID regex: alphanumeric, dash, underscore, 1 to 128 characters.
 * Prevents log injection, CRLF injection, and unbounded header size.
 */
const VALID_CORRELATION_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Generates a standard cryptographically random UUID v4 correlation ID.
 */
export function createCorrelationId(): string {
  return randomUUID();
}

/**
 * Sanitizes a client-provided correlation/request ID.
 * If invalid (contains spaces, newlines, special characters, or exceeds 128 chars), returns a new UUID.
 */
export function sanitizeCorrelationId(raw: string | null | undefined): string {
  if (!raw || typeof raw !== 'string') {
    return createCorrelationId();
  }
  const trimmed = raw.trim();
  if (VALID_CORRELATION_ID_REGEX.test(trimmed)) {
    return trimmed;
  }
  return createCorrelationId();
}

/**
 * Extracts and sanitizes correlation ID from standard HTTP headers.
 * Checks 'x-correlation-id', 'x-request-id', 'x-trace-id' in priority order.
 */
export function getCorrelationIdFromHeaders(
  headers: Headers | Record<string, string | string[] | undefined> | undefined,
): string {
  if (!headers) {
    return createCorrelationId();
  }

  const rawId =
    typeof (headers as Headers).get === 'function'
      ? ((headers as Headers).get('x-correlation-id') ??
        (headers as Headers).get('x-request-id') ??
        (headers as Headers).get('x-trace-id'))
      : (() => {
          const record = headers as Record<string, string | string[] | undefined>;
          const findHeader = (target: string) => {
            const key = Object.keys(record).find((k) => k.toLowerCase() === target);
            if (!key) return undefined;
            const val = record[key];
            return Array.isArray(val) ? val[0] : val;
          };
          return findHeader('x-correlation-id') ?? findHeader('x-request-id') ?? findHeader('x-trace-id');
        })();

  return sanitizeCorrelationId(rawId);
}

/**
 * Runs a function within the specified log context.
 */
export function runWithContext<T>(context: LogContext, fn: () => T): T {
  const current = asyncLocalStorage.getStore();
  const correlationId = context.correlationId || current?.correlationId || createCorrelationId();
  const merged: LogContext = {
    ...current,
    ...context,
    correlationId,
  };
  return asyncLocalStorage.run(merged, fn);
}

/**
 * Runs a function with an established or generated correlation ID, merging with any existing context.
 */
export function withCorrelationId<T>(
  correlationId: string | undefined,
  fn: (correlationId: string) => T,
  extra?: Partial<LogContext>,
): T {
  const safeId = sanitizeCorrelationId(correlationId);
  const current = asyncLocalStorage.getStore();
  const nextContext: LogContext = {
    ...current,
    ...extra,
    correlationId: safeId,
  };
  return asyncLocalStorage.run(nextContext, () => fn(safeId));
}

/**
 * Retrieves the current ambient log context from AsyncLocalStorage.
 */
export function getLogContext(): LogContext | undefined {
  return asyncLocalStorage.getStore();
}
