import { describe, expect, it } from 'vitest';
import { ist, istMinute } from './time';

// P3 S8c (DG-37 (j)): India Standard Time everywhere, never GMT. P3 S9a (DG-39 (c)): one 12-hour clock.
describe('IST formatting', () => {
  const at = new Date('2026-11-18T11:55:45Z');

  it('shows the time in India (UTC+5:30), 12-hour, to the second', () => {
    expect(ist(at)).toMatch(/^18 Nov 2026,? 5:25:45 pm IST$/i);
    expect(ist(at)).not.toMatch(/GMT|UTC|17:25/);
  });

  it('shows the time to the minute, marked IST', () => {
    expect(istMinute(at)).toMatch(/^18 Nov 2026,? 5:25 pm IST$/i);
  });
});
