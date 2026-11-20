import { describe, expect, it } from 'vitest';
import { formatIst, formatIstDate } from './time';

// P3 S9a (DG-39 (c)): one 12-hour IST clock everywhere.
describe('formatIst', () => {
  const at = new Date('2026-11-18T11:55:45Z');

  it('shows India time, 12-hour, to the minute, marked IST', () => {
    expect(formatIst(at)).toMatch(/^18 Nov 2026,? 5:25 pm IST$/i);
  });

  it('P3 S9b (DG-39 (d)): the day is not zero-padded, like the date-only form', () => {
    const early = new Date('2026-12-02T03:35:00Z');
    expect(formatIst(early)).toMatch(/^2 Dec 2026,? 9:05 am IST$/i);
    expect(formatIstDate(early)).toBe('2 Dec 2026');
  });

  it('adds seconds when asked', () => {
    expect(formatIst(at, { seconds: true })).toMatch(/^18 Nov 2026,? 5:25:45 pm IST$/i);
  });

  it('never shows a 24-hour clock or GMT', () => {
    expect(formatIst(at)).not.toMatch(/17:25|GMT|UTC/);
  });

  it('accepts ISO strings and does not depend on the caller time zone', () => {
    expect(formatIst('2026-11-18T18:40:00Z')).toMatch(/^19 Nov 2026,? 12:10 am IST$/i);
  });

  it('formats in Hindi with the same clock', () => {
    expect(formatIst(at, { locale: 'hi' })).toMatch(/2026,? 5:25 pm IST$/i);
  });

  it('gives the calendar day in India', () => {
    expect(formatIstDate('2026-11-18T19:00:00Z')).toBe('19 Nov 2026');
  });
});
