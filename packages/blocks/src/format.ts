/**
 * Display formatting for business details (P2 S10, acceptance run 2): opening hours a person reads at a glance
 * ("Mon–Sat: 06:00 to 22:00", "Open 24 hours, 7 days a week") and Indian phone numbers in the usual grouping.
 */
import { DAY_KEYS, t, type Locale } from './strings';

const ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
type Day = (typeof ORDER)[number];

export interface Hours {
  readonly days: readonly Day[];
  readonly open: string;
  readonly close: string;
}

/** Days in week order, runs of three or more collapsed into "Mon–Fri". */
export function daysText(days: readonly Day[], locale: Locale): string {
  const set = new Set(days);
  const idx = ORDER.filter((d) => set.has(d)).map((d) => ORDER.indexOf(d));
  const parts: string[] = [];
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1] === (idx[j] as number) + 1) j += 1;
    const name = (k: number) => t(locale, DAY_KEYS[ORDER[k] as Day]);
    if (j - i >= 2) parts.push(`${name(idx[i] as number)}–${name(idx[j] as number)}`);
    else for (let k = i; k <= j; k += 1) parts.push(name(idx[k] as number));
    i = j + 1;
  }
  return parts.join(', ');
}

export function isAlwaysOpen(hours: readonly Hours[] | undefined): boolean {
  if (!hours || hours.length === 0) return false;
  const days = new Set(
    hours
      .filter((h) => h.open === '00:00' && (h.close === '23:59' || h.close === '24:00'))
      .flatMap((h) => h.days),
  );
  return ORDER.every((d) => days.has(d));
}

export function hoursLines(hours: readonly Hours[] | undefined, locale: Locale): string[] {
  if (!hours || hours.length === 0) return [];
  if (isAlwaysOpen(hours)) return [t(locale, 'open247')];
  return hours.map((h) => `${daysText(h.days, locale)}: ${h.open} ${t(locale, 'to')} ${h.close}`);
}

/** "+919800000000" -> "+91 98000 00000"; anything else is shown as entered. */
export function formatPhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (raw.trim().startsWith('+') && digits.length === 12 && digits.startsWith('91')) {
    return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  }
  if (!raw.trim().startsWith('+') && digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`;
  return raw;
}
