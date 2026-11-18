import { describe, expect, it } from 'vitest';
import { ist, istMinute } from './time';

// P3 S8c (DG-37 (j)): the dashboard shows India Standard Time everywhere, never GMT.
describe('IST formatting', () => {
  const at = new Date('2026-11-18T11:55:45Z');

  it('shows the time in India (UTC+5:30), to the second', () => {
    expect(ist(at)).toMatch(/18 Nov 2026,? 17:25:45/);
    expect(ist(at)).not.toMatch(/GMT|UTC/);
  });

  it('shows the time to the minute, marked IST', () => {
    expect(istMinute(at)).toMatch(/^18 Nov 2026,? 17:25 IST$/);
  });
});
