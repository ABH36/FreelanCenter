import { describe, expect, it } from 'vitest';
import { daysText, formatPhone, hoursLines, isAlwaysOpen } from './format';

describe('opening hours and phone numbers as people read them (P2 S10)', () => {
  it('collapses runs of three or more days', () => {
    expect(daysText(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'], 'en')).toBe('Mon–Sat');
    expect(daysText(['sat', 'sun'], 'en')).toBe('Sat, Sun');
    expect(daysText(['mon', 'wed', 'thu', 'fri'], 'en')).toBe('Mon, Wed–Fri');
  });
  it('says "open 24 hours, 7 days" instead of 00:00 to 23:59 every day', () => {
    const all = [
      { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const, open: '00:00', close: '23:59' },
    ];
    expect(isAlwaysOpen(all)).toBe(true);
    expect(hoursLines(all, 'en')).toEqual(['Open 24 hours, 7 days a week']);
    expect(hoursLines(all, 'hi')).toEqual(['24 घंटे, सातों दिन खुला']);
    expect(hoursLines([{ days: ['mon', 'tue', 'wed'], open: '09:00', close: '18:00' }], 'en')).toEqual([
      'Mon–Wed: 09:00 to 18:00',
    ]);
  });
  it('groups Indian numbers and leaves anything else as entered', () => {
    expect(formatPhone('+919800000000')).toBe('+91 98000 00000');
    expect(formatPhone('9800000000')).toBe('98000 00000');
    expect(formatPhone('+44 20 7946 0000')).toBe('+44 20 7946 0000');
  });
});
