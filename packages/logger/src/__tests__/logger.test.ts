import { describe, expect, it } from 'vitest';
import { runWithContext } from '../context';
import { createLogger, type LogEntry } from '../logger';
import { REDACTED_EMAIL, REDACTED_VALUE } from '../redact';

describe('createLogger and StructuredLogger', () => {
  it('outputs structured JSON entries with correlationId and timestamp', () => {
    const logs: LogEntry[] = [];
    const logger = createLogger({
      app: 'dashboard',
      minLevel: 'debug',
      sink: (_line, entry) => logs.push(entry),
    });

    logger.info('User viewed dashboard', { view: 'overview' });

    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.level).toBe('info');
    expect(entry.message).toBe('User viewed dashboard');
    expect(entry.app).toBe('dashboard');
    expect(entry.correlationId).toBeDefined();
    expect(entry.correlationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(new Date(entry.timestamp).getTime()).not.toBeNaN();
    expect(entry.data).toEqual({ view: 'overview' });
  });

  it('inherits correlationId and workspaceId from ambient AsyncLocalStorage context', () => {
    const logs: LogEntry[] = [];
    const logger = createLogger({
      app: 'dashboard',
      sink: (_line, entry) => logs.push(entry),
    });

    runWithContext(
      {
        correlationId: 'ctx-corr-999',
        workspaceId: 'ws-tenant-alpha',
        deploymentSurface: 'dashboard-preview',
      },
      () => {
        logger.info('Tenant action executed');
      },
    );

    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.correlationId).toBe('ctx-corr-999');
    expect(entry.workspaceId).toBe('ws-tenant-alpha');
    expect(entry.deploymentSurface).toBe('dashboard-preview');
  });

  it('filters logs below the configured minLevel', () => {
    const logs: LogEntry[] = [];
    const logger = createLogger({
      minLevel: 'warn',
      sink: (_line, entry) => logs.push(entry),
    });

    logger.trace('trace message');
    logger.debug('debug message');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message');

    expect(logs).toHaveLength(2);
    expect(logs[0]?.level).toBe('warn');
    expect(logs[1]?.level).toBe('error');
  });

  it('automatically redacts sensitive data and PII in messages and data payloads', () => {
    const logs: LogEntry[] = [];
    const logger = createLogger({
      minLevel: 'debug',
      sink: (_line, entry) => logs.push(entry),
    });

    logger.info('Login attempt for admin@agency.com with password secret123', {
      user: {
        email: 'admin@agency.com',
        password: 'cleartext-password',
        sessionToken: 'sess_secret_token_123',
      },
      headers: {
        authorization: 'Bearer secret_access_token',
        cookie: 'sessionId=secret_cookie_val',
      },
    });

    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.message).toContain(REDACTED_EMAIL);
    expect(entry.message).not.toContain('admin@agency.com');

    const data = entry.data as {
      user: { email: string; password: string; sessionToken: string };
      headers: { authorization: string; cookie: string };
    };

    expect(data.user.email).toBe(REDACTED_EMAIL);
    expect(data.user.password).toBe(REDACTED_VALUE);
    expect(data.user.sessionToken).toBe(REDACTED_VALUE);
    expect(data.headers.authorization).toBe(REDACTED_VALUE);
    expect(data.headers.cookie).toBe(`sessionId=${REDACTED_VALUE}`);
  });

  it('redacts error messages and stack traces', () => {
    const logs: LogEntry[] = [];
    const logger = createLogger({
      sink: (_line, entry) => logs.push(entry),
    });

    const error = new Error('Database connect error: postgres://app:supersecret@localhost:5432/db');
    logger.error('Query failed', error, { query: 'SELECT 1' });

    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.level).toBe('error');

    const err = entry.error as { message: string; stack?: string };
    expect(err.message).toBe(`Database connect error: postgres://app:${REDACTED_VALUE}@localhost:5432/db`);
    expect(err.message).not.toContain('supersecret');
  });

  it('creates child loggers with merged and redacted bindings', () => {
    const logs: LogEntry[] = [];
    const rootLogger = createLogger({
      app: 'sites',
      sink: (_line, entry) => logs.push(entry),
    });

    const childLogger = rootLogger.child({
      module: 'renderer',
      projectSlug: 'sharma-taxi',
      authSecret: 'must-be-redacted',
    });

    childLogger.info('Rendering page', { page: '/about' });

    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry.app).toBe('sites');
    expect(entry.module).toBe('renderer');
    expect(entry.projectSlug).toBe('sharma-taxi');
    expect(entry.authSecret).toBe(REDACTED_VALUE);
  });

  describe('security regression tests', () => {
    it('asserts the final JSON log line does not contain cleartext secrets', () => {
      const logLines: string[] = [];
      const logger = createLogger({
        app: 'dashboard',
        sink: (line) => logLines.push(line),
      });

      const err = new Error('Connection failed: postgres://dbuser:supersecretpass@localhost:5432/main');
      (err as unknown as { code: string }).code = 'ERR_TOKEN_secret_token_123';
      (err as unknown as { customSecret: string }).customSecret = 'hidden_secret_val';

      logger.error('Login failure with password cleartext-pw-456 and token: secret-token-abc', err, {
        apiKey: 'sk-ant-api03-12345678901234567890',
        url: 'https://example.com/api?token=query-secret-token',
        userEmail: 'sensitive@customer.org',
        headers: {
          authorization: 'Bearer super_bearer_secret',
        },
      });

      expect(logLines).toHaveLength(1);
      const line = logLines[0]!;

      // Cleartext secrets must NOT appear anywhere in the serialized JSON line
      expect(line).not.toContain('supersecretpass');
      expect(line).not.toContain('cleartext-pw-456');
      expect(line).not.toContain('secret-token-abc');
      expect(line).not.toContain('secret_token_123');
      expect(line).not.toContain('hidden_secret_val');
      expect(line).not.toContain('sk-ant-api03-12345678901234567890');
      expect(line).not.toContain('query-secret-token');
      expect(line).not.toContain('sensitive@customer.org');
      expect(line).not.toContain('super_bearer_secret');

      // Must be valid JSON
      expect(() => JSON.parse(line)).not.toThrow();
    });

    it('asserts bare password, secret, token, and api-key patterns are redacted in log messages', () => {
      const logs: LogEntry[] = [];
      const logger = createLogger({
        sink: (_line, entry) => logs.push(entry),
      });

      logger.info('User password cleartext-value-123');
      logger.info('Found secret=very-secret-val in request');
      logger.info('Header token: my-secret-token-xyz');
      logger.info('Config api_key=my_api_key_value');
      logger.info('Provided apiKey: myApiKeyVal');
      logger.info('User password is myPlainTextPassword');

      // Preserved non-sensitive message text
      logger.info('User password reset successfully');
      logger.info('Password policy applied');
      logger.info('token rotation completed');

      expect(logs[0]?.message).toBe(`User password ${REDACTED_VALUE}`);
      expect(logs[1]?.message).toBe(`Found secret=${REDACTED_VALUE} in request`);
      expect(logs[2]?.message).toBe(`Header token: ${REDACTED_VALUE}`);
      expect(logs[3]?.message).toBe(`Config api_key=${REDACTED_VALUE}`);
      expect(logs[4]?.message).toBe(`Provided apiKey: ${REDACTED_VALUE}`);
      expect(logs[5]?.message).toBe(`User password is ${REDACTED_VALUE}`);

      expect(logs[6]?.message).toBe('User password reset successfully');
      expect(logs[7]?.message).toBe('Password policy applied');
      expect(logs[8]?.message).toBe('token rotation completed');
    });

    it('asserts Error.code cannot leak a token or secret', () => {
      const logs: LogEntry[] = [];
      const logger = createLogger({
        sink: (_line, entry) => logs.push(entry),
      });

      const err = new Error('Auth failure');
      (err as unknown as { code: string }).code = 'ERR_TOKEN_xyz_secret_999';

      logger.error('Failed to authenticate', err);

      expect(logs).toHaveLength(1);
      const errObj = logs[0]?.error as { code: string };
      expect(errObj.code).toBe(`ERR_TOKEN_${REDACTED_VALUE}`);
      expect(errObj.code).not.toContain('xyz_secret_999');
    });

    it('asserts child bindings cannot overwrite correlationId or tenant/app identity', () => {
      const logs: LogEntry[] = [];
      const rootLogger = createLogger({
        app: 'dashboard',
        sink: (_line, entry) => logs.push(entry),
      });

      const childLogger = rootLogger.child({
        // Malicious bindings attempting to spoof identity and audit envelope
        correlationId: 'spoofed-correlation-id',
        workspaceId: 'spoofed-workspace-id',
        projectId: 'spoofed-project-id',
        userId: 'spoofed-user-id',
        app: 'spoofed-app',
        deploymentSurface: 'spoofed-surface',
        timestamp: '1970-01-01T00:00:00.000Z',
        level: 'fatal',
        message: 'spoofed-message',
        error: 'spoofed-error',
        data: 'spoofed-data',
        // Legitimate child binding
        component: 'billing-service',
      });

      runWithContext(
        {
          correlationId: 'authoritative-corr-123',
          workspaceId: 'authoritative-ws-456',
          projectId: 'authoritative-prj-789',
          userId: 'authoritative-usr-000',
        },
        () => {
          childLogger.info('Legitimate action executed');
        },
      );

      expect(logs).toHaveLength(1);
      const entry = logs[0]!;

      // System and security integrity fields must NOT be overwritten by child bindings
      expect(entry.correlationId).toBe('authoritative-corr-123');
      expect(entry.workspaceId).toBe('authoritative-ws-456');
      expect(entry.projectId).toBe('authoritative-prj-789');
      expect(entry.userId).toBe('authoritative-usr-000');
      expect(entry.app).toBe('dashboard');
      expect(entry.level).toBe('info');
      expect(entry.message).toBe('Legitimate action executed');
      expect(entry.timestamp).not.toBe('1970-01-01T00:00:00.000Z');
      expect(entry.error).toBeUndefined();
      expect(entry.data).toBeUndefined();

      // Legitimate binding is preserved
      expect(entry.component).toBe('billing-service');
    });
  });
});
