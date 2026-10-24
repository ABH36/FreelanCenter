'use server';
/**
 * Notification server actions (P1 S6, FR-NOT-01). Only the signed-in member's own notifications and preferences
 * are reachable (RLS `recipient_*` / `self_*`); ids in the form are selectors. Registered with the IDOR harness
 * in tests/isolation/src/actions.ts.
 */
import { revalidatePath } from 'next/cache';
import { CATEGORY_NAMES } from '@platform/workspaces';
import { type ActionState, field, runAction } from '@/lib/actions';
import { notificationService, requireUserId } from '@/lib/workspaces';

export async function markNotificationReadAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    await (
      await notificationService()
    ).markNotificationRead(userId, {
      workspaceId: field(form, 'workspaceId'),
      notificationId: field(form, 'notificationId'),
    });
    revalidatePath('/', 'layout');
  });
}

export async function markAllNotificationsReadAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    await (
      await notificationService()
    ).markAllNotificationsRead(userId, { workspaceId: field(form, 'workspaceId') });
    revalidatePath('/', 'layout');
    return { ok: 'All marked as read.' };
  });
}

/** One checkbox per category and channel: `<category>:in_app`, `<category>:email`. */
export async function saveNotificationPreferencesAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    const preferences = Object.fromEntries(
      CATEGORY_NAMES.map((c) => [
        c,
        { inApp: form.get(`${c}:in_app`) === 'on', email: form.get(`${c}:email`) === 'on' },
      ]),
    );
    await (
      await notificationService()
    ).savePreferences(userId, { workspaceId: field(form, 'workspaceId'), preferences });
    revalidatePath('/', 'layout');
    return { ok: 'Preferences saved.' };
  });
}
