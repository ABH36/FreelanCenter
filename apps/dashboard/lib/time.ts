/**
 * Times in India Standard Time, the product's home time zone (acceptance C-15; P3 S8c, DG-37 (j): notifications,
 * invitations and the deletion notice used to show GMT). P3 S9a (DG-39 (c)): one 12-hour clock everywhere,
 * from `@platform/ui/time`.
 */
import { formatIst } from '@platform/ui/time';

export { formatIst, formatIstDate } from '@platform/ui/time';

/** To the second, for lists where events can share a minute (audit log): "18 Nov 2026, 5:25:45 pm IST". */
export const ist = (d: Date | string) => formatIst(d, { seconds: true });

/** To the minute, for sentences and notices ("expires 02 Dec 2026, 5:24 pm IST"). */
export const istMinute = (d: Date | string) => formatIst(d);
