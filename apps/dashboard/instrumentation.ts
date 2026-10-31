/**
 * Error tracking (FR-OBS-01, P1 S9). Runs once per server start. Sentry is off unless SENTRY_DSN_DASHBOARD is set to an
 * EU-region DSN (SEC-21); every event passes through `scrubSentryEvent` first (ids only, no PII, SEC-05). Server
 * side only in Phase 1: no browser SDK, no tracing, no session replay, no tunnel route.
 */
import * as Sentry from '@sentry/nextjs';
import { checkSentryDsn, createLogger, sentryOptions } from '@platform/logger';

export function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const dsn = checkSentryDsn(process.env.SENTRY_DSN_DASHBOARD);
  if (!dsn.ok) {
    // An unset DSN is normal (local, CI); a bad or non-EU one is a configuration error worth a log line.
    if (dsn.reason !== 'unset') {
      createLogger({ app: 'dashboard' }).warn('observability.sentry.disabled', { reason: dsn.reason });
    }
    return;
  }
  Sentry.init(sentryOptions(dsn.dsn, process.env.VERCEL_ENV ?? 'local', process.env.VERCEL_GIT_COMMIT_SHA));
}

export const onRequestError = Sentry.captureRequestError;
