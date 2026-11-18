/**
 * One clock for the whole product (P3 S9a, DG-39 (c)): India Standard Time, 12-hour, marked IST, e.g.
 * "18 Nov 2026, 5:25 pm IST". The Owner chose the 12-hour form on 2026-11-18. Every screen, notice and e-mail
 * uses this module; the time zone is fixed, so a server in another region or a browser elsewhere shows the same
 * time. Seconds are for lists where events can share a minute (audit log, version history).
 */
export type ClockLocale = 'en' | 'hi';

export interface ClockOptions {
  /** Include seconds ("5:25:45 pm"). */
  seconds?: boolean;
  locale?: ClockLocale;
}

const TIME_ZONE = 'Asia/Kolkata';
const LOCALES: Record<ClockLocale, string> = { en: 'en-IN', hi: 'hi-IN' };

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/** "18 Nov 2026, 5:25 pm IST" (with `seconds`: "18 Nov 2026, 5:25:45 pm IST"). */
export function formatIst(value: Date | string, options: ClockOptions = {}): string {
  const text = new Intl.DateTimeFormat(LOCALES[options.locale ?? 'en'], {
    timeZone: TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
    hour12: true,
  }).format(toDate(value));
  return `${text} IST`;
}

/** The calendar day in India: "18 Nov 2026". */
export function formatIstDate(value: Date | string, options: Pick<ClockOptions, 'locale'> = {}): string {
  return new Intl.DateTimeFormat(LOCALES[options.locale ?? 'en'], {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(toDate(value));
}
