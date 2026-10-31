/**
 * Error-tracking policy for both apps (FR-OBS-01, SEC-05, SEC-21, ADR-013). Pure functions, no Sentry import:
 * the apps' `instrumentation.ts` hands them to `Sentry.init`, and the unit tests prove what leaves the process.
 *
 * - The DSN must point at Sentry's EU region (`*.de.sentry.io`), the region recorded in the privacy inventory.
 *   Any other value disables reporting instead of sending data to an unrecorded region.
 * - An event carries ids, route and stack only: request headers, cookies, query strings, bodies, user records and
 *   free-text values are removed or redacted before the event is queued (`scrubSentryEvent`).
 */
import { redact, redactString } from './redact';

export type SentryDsnCheck =
  { ok: true; dsn: string } | { ok: false; reason: 'unset' | 'invalid' | 'not_eu' };

export function checkSentryDsn(raw: string | undefined): SentryDsnCheck {
  const value = raw?.trim();
  if (!value) return { ok: false, reason: 'unset' };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'invalid' };
  if (!url.hostname.endsWith('.de.sentry.io')) return { ok: false, reason: 'not_eu' };
  return { ok: true, dsn: value };
}

/** The slice of a Sentry event the scrubber touches; anything else passes through unchanged. */
export interface ScrubbableEvent {
  user?: unknown;
  server_name?: unknown;
  message?: unknown;
  request?: {
    url?: unknown;
    headers?: unknown;
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    env?: unknown;
  };
  exception?: { values?: Array<{ value?: unknown }> };
  breadcrumbs?: Array<{ message?: unknown; data?: unknown }>;
  extra?: unknown;
  contexts?: object;
  tags?: object;
}

/** Drops the query and hash of a URL: reset and verification tokens travel there (SEC-11). */
function stripUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redactString(value.split(/[?#]/)[0] ?? '');
  }
}

export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T {
  const out: ScrubbableEvent = { ...event };
  // Who: an id at most. Name, e-mail and IP address never leave.
  const user = event.user as { id?: unknown } | undefined;
  out.user = typeof user?.id === 'string' ? { id: user.id } : undefined;
  delete out.server_name;
  if (event.request) {
    out.request = { url: stripUrl(event.request.url) };
  }
  if (typeof event.message === 'string') out.message = redactString(event.message);
  if (event.exception?.values) {
    out.exception = {
      ...event.exception,
      values: event.exception.values.map((v) =>
        typeof v.value === 'string' ? { ...v, value: redactString(v.value) } : v,
      ),
    };
  }
  if (event.breadcrumbs) {
    out.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      message: typeof b.message === 'string' ? redactString(b.message) : b.message,
      data: b.data === undefined ? undefined : redact(b.data),
    }));
  }
  if (event.extra !== undefined) out.extra = redact(event.extra);
  if (event.contexts) {
    // The trace ids are 16/32 hex digits: the card-number pattern would mangle them and break trace linking.
    const { trace, ...rest } = event.contexts as Record<string, unknown>;
    out.contexts = { ...redact(rest), ...(trace === undefined ? {} : { trace }) };
  }
  if (event.tags) out.tags = redact(event.tags);
  return out as T;
}

/**
 * Sentry v11 collects headers, cookies, bodies, query parameters, user info, database data and local variables by
 * default; this switches every one of them off (`dataCollection` init option). `scrubSentryEvent` is the second layer.
 */
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
} as const;

/** The options both apps pass to `Sentry.init` (apps add nothing but the DSN check and `release`). */
export function sentryOptions(dsn: string, environment: string, release?: string) {
  return {
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: <T extends ScrubbableEvent>(event: T): T => scrubSentryEvent(event),
  };
}
