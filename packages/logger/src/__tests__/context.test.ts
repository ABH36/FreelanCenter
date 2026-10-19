import { describe, expect, it } from 'vitest';
import {
  createCorrelationId,
  getCorrelationIdFromHeaders,
  getLogContext,
  runWithContext,
  sanitizeCorrelationId,
  withCorrelationId,
} from '../context';

describe('context and correlation ID management', () => {
  it('generates a valid UUID v4 correlation ID', () => {
    const id = createCorrelationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('sanitizes clean correlation IDs and rejects malicious / invalid ones', () => {
    const valid = 'corr-req-123_abc';
    expect(sanitizeCorrelationId(valid)).toBe('corr-req-123_abc');

    // Control characters or CRLF injection attempt
    const crlf = 'valid-id\r\nInjected-Header: evil';
    const crlfSanitized = sanitizeCorrelationId(crlf);
    expect(crlfSanitized).not.toBe(crlf);
    expect(crlfSanitized).toMatch(/^[0-9a-f-]{36}$/i);

    // Spaces or punctuation
    const spaces = 'bad id with spaces';
    expect(sanitizeCorrelationId(spaces)).not.toBe(spaces);

    // Empty or non-string
    expect(sanitizeCorrelationId('')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sanitizeCorrelationId(null)).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sanitizeCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/i);

    // Exceeds 128 characters length cap
    const tooLong = 'a'.repeat(129);
    expect(sanitizeCorrelationId(tooLong)).not.toBe(tooLong);
    expect(sanitizeCorrelationId(tooLong)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('extracts correlation ID from headers with priority order', () => {
    // 1. x-correlation-id takes precedence
    const headers1 = new Headers({
      'x-correlation-id': 'client-corr-001',
      'x-request-id': 'req-002',
    });
    expect(getCorrelationIdFromHeaders(headers1)).toBe('client-corr-001');

    // 2. x-request-id fallback
    const headers2 = new Headers({
      'x-request-id': 'req-002',
    });
    expect(getCorrelationIdFromHeaders(headers2)).toBe('req-002');

    // 3. plain record case-insensitivity
    const headersRecord = {
      'X-Request-Id': 'req-record-003',
    };
    expect(getCorrelationIdFromHeaders(headersRecord)).toBe('req-record-003');

    // 4. missing headers generates new UUID
    expect(getCorrelationIdFromHeaders(undefined)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('propagates context via runWithContext across async operations', async () => {
    expect(getLogContext()).toBeUndefined();

    const result = await runWithContext(
      {
        correlationId: 'test-corr-async',
        workspaceId: 'ws-777',
        app: 'dashboard',
      },
      async () => {
        const ambient1 = getLogContext();
        expect(ambient1?.correlationId).toBe('test-corr-async');
        expect(ambient1?.workspaceId).toBe('ws-777');
        expect(ambient1?.app).toBe('dashboard');

        // Verify across Promise resolution
        await new Promise((resolve) => setTimeout(resolve, 10));

        const ambient2 = getLogContext();
        expect(ambient2?.correlationId).toBe('test-corr-async');
        return 'completed';
      },
    );

    expect(result).toBe('completed');
    expect(getLogContext()).toBeUndefined();
  });

  it('isolates context between concurrent async calls', async () => {
    const runCall = (id: string, delayMs: number) =>
      runWithContext({ correlationId: id }, async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return getLogContext()?.correlationId;
      });

    const [resA, resB] = await Promise.all([runCall('branch-A', 20), runCall('branch-B', 10)]);

    expect(resA).toBe('branch-A');
    expect(resB).toBe('branch-B');
  });

  it('works with withCorrelationId helper', () => {
    const output = withCorrelationId('corr-helper-123', (corrId) => {
      expect(corrId).toBe('corr-helper-123');
      expect(getLogContext()?.correlationId).toBe('corr-helper-123');
      return 42;
    });
    expect(output).toBe(42);
  });
});
