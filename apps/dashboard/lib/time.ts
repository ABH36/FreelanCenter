/**
 * Times in India Standard Time, the product's home time zone (acceptance C-15; P3 S8c, DG-37 (j): notifications,
 * invitations and the deletion notice used to show GMT).
 */
export const ist = (d: Date) =>
  d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

/** The same, to the minute and marked IST, for sentences ("expires 02 Dec 2026, 17:24 IST"). */
export const istMinute = (d: Date) =>
  `${d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })} IST`;
