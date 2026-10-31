/**
 * @platform/logger
 * Shared structured redacting logger with correlation IDs and AsyncLocalStorage context.
 * Satisfies FR-OBS-01, SEC-05, SEC-15, and DG-03.
 */

export {
  type LogContext,
  createCorrelationId,
  sanitizeCorrelationId,
  getCorrelationIdFromHeaders,
  runWithContext,
  withCorrelationId,
  getLogContext,
} from './context';

export {
  type RedactOptions,
  redact,
  redactString,
  redactCookieString,
  REDACTED_VALUE,
  REDACTED_EMAIL,
  REDACTED_PHONE,
  REDACTED_CARD,
  REDACTED_NATIONAL_ID,
  REDACTED_JWT,
  REDACTED_API_KEY,
} from './redact';

export {
  type LogLevel,
  type LogEntry,
  type LogSink,
  type LoggerOptions,
  type Logger,
  type ReservedLogField,
  RESERVED_LOG_FIELDS,
  LOG_LEVEL_SEVERITY,
  sanitizeBindings,
  createLogger,
} from './logger';

export {
  type SentryDsnCheck,
  type ScrubbableEvent,
  SENTRY_DATA_COLLECTION,
  checkSentryDsn,
  scrubSentryEvent,
  sentryOptions,
} from './sentry';
