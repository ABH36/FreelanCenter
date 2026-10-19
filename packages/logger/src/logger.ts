/**
 * @platform/logger - Structured Redacting Logger
 * Implements structured JSON logging with correlation IDs, tenant isolation tags, and automatic redaction.
 * Satisfies FR-OBS-01, SEC-05, and Module 16 Operational Contract.
 */

import { type LogContext, createCorrelationId, getLogContext, runWithContext } from './context';
import { redact, redactString } from './redact';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVEL_SEVERITY: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/**
 * Reserved log entry fields that define log envelope, security context, and audit integrity.
 * These fields MUST NEVER be overridden or spoofed by child logger bindings.
 */
export const RESERVED_LOG_FIELDS = [
  'timestamp',
  'level',
  'message',
  'correlationId',
  'workspaceId',
  'projectId',
  'userId',
  'app',
  'deploymentSurface',
  'error',
  'data',
] as const;

export type ReservedLogField = (typeof RESERVED_LOG_FIELDS)[number];
const RESERVED_LOG_FIELDS_SET = new Set<string>(RESERVED_LOG_FIELDS);

/**
 * Documented Safe Merge Policy for Child Logger Bindings:
 * 1. Reserved integrity fields ('timestamp', 'level', 'message', 'correlationId', 'workspaceId',
 *    'projectId', 'userId', 'app', 'deploymentSurface', 'error', 'data') are stripped from
 *    user-supplied bindings upon logger instantiation or child creation.
 * 2. Any non-reserved contextual fields (e.g. 'module', 'action', 'route') are deep-redacted
 *    and merged into the logger's immutable bindings.
 * 3. At log emission time, the authoritative system context (timestamp, current log level,
 *    redacted message, ambient correlationId/workspaceId from AsyncLocalStorage, configured app,
 *    and deploymentSurface) strictly takes precedence, preventing any tampering.
 */
export function sanitizeBindings(bindings?: Record<string, unknown>): Record<string, unknown> {
  if (!bindings) return {};
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(bindings)) {
    if (!RESERVED_LOG_FIELDS_SET.has(key)) {
      safe[key] = value;
    }
  }
  return safe;
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId: string;
  workspaceId?: string;
  projectId?: string;
  userId?: string;
  app?: string;
  deploymentSurface?: string;
  error?: unknown;
  data?: unknown;
  [key: string]: unknown;
}

export type LogSink = (line: string, entry: LogEntry) => void;

export interface LoggerOptions {
  name?: string;
  app?: string;
  minLevel?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
}

export interface Logger {
  trace(message: string, data?: unknown): void;
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, errorOrData?: unknown, data?: unknown): void;
  fatal(message: string, errorOrData?: unknown, data?: unknown): void;
  child(bindings: Record<string, unknown>): Logger;
  withContext<T>(context: Partial<LogContext>, fn: () => T): T;
}

function resolveMinLevel(explicit?: LogLevel): LogLevel {
  if (explicit && explicit in LOG_LEVEL_SEVERITY) {
    return explicit;
  }
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && envLevel in LOG_LEVEL_SEVERITY) {
    return envLevel as LogLevel;
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
}

function defaultSink(line: string, entry: LogEntry): void {
  if (entry.level === 'error' || entry.level === 'fatal') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

class StructuredLogger implements Logger {
  private readonly app?: string;
  private readonly minLevel: LogLevel;
  private readonly minLevelNum: number;
  private readonly sink: LogSink;
  private readonly bindings: Record<string, unknown>;

  constructor(options: LoggerOptions = {}) {
    this.app = options.app;
    this.minLevel = resolveMinLevel(options.minLevel);
    this.minLevelNum = LOG_LEVEL_SEVERITY[this.minLevel];
    this.sink = options.sink ?? defaultSink;
    this.bindings = options.bindings ? redact(sanitizeBindings(options.bindings)) : {};
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_SEVERITY[level] >= this.minLevelNum;
  }

  private write(level: LogLevel, rawMessage: string, rawData?: unknown, rawError?: unknown): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const ambient = getLogContext();
    const correlationId = ambient?.correlationId ?? createCorrelationId();
    const workspaceId = ambient?.workspaceId;
    const projectId = ambient?.projectId;
    const userId = ambient?.userId;
    const app = this.app ?? ambient?.app;
    const deploymentSurface = ambient?.deploymentSurface ?? process.env.PLATFORM_DEPLOYMENT_SURFACE;

    const message = redactString(rawMessage);

    // Safe merge policy:
    // User bindings are placed first; authoritative system context strictly overrides.
    const entry: LogEntry = {
      ...this.bindings,
      timestamp: new Date().toISOString(),
      level,
      message,
      correlationId,
      ...(workspaceId ? { workspaceId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(userId ? { userId } : {}),
      ...(app ? { app } : {}),
      ...(deploymentSurface ? { deploymentSurface } : {}),
    };

    if (rawError !== undefined) {
      entry.error = redact(rawError);
    }

    if (rawData !== undefined) {
      entry.data = redact(rawData);
    }

    try {
      const line = JSON.stringify(entry);
      this.sink(line, entry);
    } catch {
      // Fallback if stringification encounters unexpected failure
      const fallbackEntry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        correlationId,
        serializationError: 'Failed to serialize log entry',
      };
      this.sink(JSON.stringify(fallbackEntry), fallbackEntry as LogEntry);
    }
  }

  trace(message: string, data?: unknown): void {
    this.write('trace', message, data);
  }

  debug(message: string, data?: unknown): void {
    this.write('debug', message, data);
  }

  info(message: string, data?: unknown): void {
    this.write('info', message, data);
  }

  warn(message: string, data?: unknown): void {
    this.write('warn', message, data);
  }

  error(message: string, errorOrData?: unknown, data?: unknown): void {
    if (errorOrData instanceof Error) {
      this.write('error', message, data, errorOrData);
    } else if (data !== undefined) {
      this.write('error', message, data, errorOrData);
    } else {
      this.write('error', message, errorOrData, undefined);
    }
  }

  fatal(message: string, errorOrData?: unknown, data?: unknown): void {
    if (errorOrData instanceof Error) {
      this.write('fatal', message, data, errorOrData);
    } else if (data !== undefined) {
      this.write('fatal', message, data, errorOrData);
    } else {
      this.write('fatal', message, errorOrData, undefined);
    }
  }

  child(bindings: Record<string, unknown>): Logger {
    return new StructuredLogger({
      app: this.app,
      minLevel: this.minLevel,
      sink: this.sink,
      bindings: {
        ...this.bindings,
        ...redact(sanitizeBindings(bindings)),
      },
    });
  }

  withContext<T>(context: Partial<LogContext>, fn: () => T): T {
    const ambient = getLogContext();
    const correlationId = context.correlationId ?? ambient?.correlationId ?? createCorrelationId();
    const fullContext: LogContext = {
      correlationId,
      ...ambient,
      ...context,
    };
    return runWithContext(fullContext, fn);
  }
}

/**
 * Creates a structured logger instance with options.
 */
export function createLogger(options?: LoggerOptions): Logger {
  return new StructuredLogger(options);
}
