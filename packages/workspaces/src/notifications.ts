/**
 * In-app notifications with per-member preferences (FR-NOT-01, module 09). A notification row is addressed to one
 * member (composite FK to memberships) and only that member can read it (RLS `recipient_select`). Preferences are
 * per category and channel; a missing row means the category default below.
 *
 * - In-app: decides whether the notification shows in the member's inbox and unread count (evaluated when read,
 *   so switching a category off hides its existing notifications too).
 * - E-mail: decided when the notification is created; the job re-checks the choice before it sends (a member who
 *   switched e-mail off in between gets nothing). The request writes an outbox row in the same transaction, and
 *   the e-mail goes out through `notification.email.v1` (capture transport until DG-10).
 */
import type { TenantDatabase, TenantScope, Tx } from '@platform/db';
import { uuidv7 } from '@platform/db';
import type { Logger } from '@platform/logger';
import { z } from 'zod';
import { WorkspaceError } from './errors';
import { OUTBOX_EVENTS } from './outbox';
import { createScopedRunner, parse, requireId } from './scoped';

export interface CategorySpec {
  label: string;
  /** Notification types that belong to the category. */
  types: readonly string[];
  defaults: { inApp: boolean; email: boolean };
  /** false: the category has no e-mail path (yet); the e-mail switch is not offered. */
  emailAvailable: boolean;
}

export const NOTIFICATION_CATEGORIES = {
  'project.review': {
    label: 'A project is waiting for my review',
    types: ['project.review_requested'],
    defaults: { inApp: true, email: true },
    emailAvailable: true,
  },
  'project.status': {
    label: 'The status of a project I created changed',
    types: ['project.status_changed'],
    defaults: { inApp: true, email: true },
    emailAvailable: true,
  },
  'workspace.members': {
    label: 'Someone accepted my invitation',
    // Written by app.accept_invitation (S5), in-app only.
    types: ['workspace.invitation_accepted'],
    defaults: { inApp: true, email: false },
    emailAvailable: false,
  },
} as const satisfies Record<string, CategorySpec>;

export type NotificationCategory = keyof typeof NOTIFICATION_CATEGORIES;
export const CATEGORY_NAMES = Object.keys(NOTIFICATION_CATEGORIES) as NotificationCategory[];

export function categoryOf(type: string): NotificationCategory | null {
  for (const name of CATEGORY_NAMES) {
    if ((NOTIFICATION_CATEGORIES[name].types as readonly string[]).includes(type)) return name;
  }
  return null;
}

export type Preferences = Record<NotificationCategory, { inApp: boolean; email: boolean }>;

function resolvePreferences(rows: Array<{ category: string; inApp: boolean; email: boolean }>): Preferences {
  const prefs = Object.fromEntries(
    CATEGORY_NAMES.map((c) => [c, { ...NOTIFICATION_CATEGORIES[c].defaults }]),
  ) as Preferences;
  for (const row of rows) {
    if (row.category in prefs) {
      const c = row.category as NotificationCategory;
      prefs[c] = { inApp: row.inApp, email: NOTIFICATION_CATEGORIES[c].emailAvailable && row.email };
    }
  }
  return prefs;
}

/** The e-mail choice the delivery job re-checks: an explicit row wins, else the category default. */
export function emailWanted(category: NotificationCategory, explicit: boolean | null | undefined): boolean {
  const spec = NOTIFICATION_CATEGORIES[category];
  return spec.emailAvailable && (explicit ?? spec.defaults.email);
}

export interface NotifyInput {
  category: NotificationCategory;
  type: string;
  recipients: readonly string[];
  /** Ids and short codes only (CHECK: bounded); names are reloaded when shown. */
  payload: Record<string, string>;
}

/**
 * Inside a command's transaction: one notification per recipient (unless both channels are off for them) and
 * one outbox row per e-mail to send. Returns the outbox ids, to dispatch after commit. `createMany` with ids made
 * here, because INSERT ... RETURNING would have to pass the recipient-only SELECT policy.
 */
export async function notify(tx: Tx, scope: TenantScope, input: NotifyInput): Promise<string[]> {
  const recipients = [...new Set(input.recipients)].filter((id) => id !== scope.actorUserId);
  if (recipients.length === 0) return [];
  const rows = await tx.notificationPreference.findMany({
    where: { userId: { in: recipients }, category: input.category },
    select: { userId: true, inApp: true, email: true },
  });
  const explicit = new Map(rows.map((r) => [r.userId, r]));
  const defaults = NOTIFICATION_CATEGORIES[input.category].defaults;
  const notifications: Array<{ id: string; userId: string }> = [];
  const outbox: Array<{ id: string; workspaceId: string; event: string; payload: Record<string, string> }> =
    [];
  for (const userId of recipients) {
    const pref = explicit.get(userId);
    const inApp = pref?.inApp ?? defaults.inApp;
    const email = emailWanted(input.category, pref?.email);
    if (!inApp && !email) continue;
    const id = uuidv7();
    notifications.push({ id, userId });
    if (email) {
      outbox.push({
        id: uuidv7(),
        workspaceId: scope.workspaceId,
        event: OUTBOX_EVENTS.notificationEmail,
        payload: { workspaceId: scope.workspaceId, notificationId: id },
      });
    }
  }
  if (notifications.length === 0) return [];
  await tx.notification.createMany({
    data: notifications.map((n) => ({
      id: n.id,
      workspaceId: scope.workspaceId,
      userId: n.userId,
      type: input.type,
      payload: input.payload,
    })),
  });
  if (outbox.length) await tx.outboxEvent.createMany({ data: outbox });
  return outbox.map((o) => o.id);
}

export interface NotificationRow {
  id: string;
  type: string;
  category: NotificationCategory | null;
  payload: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export const NOTIFICATION_PAGE_SIZE = 30;

// partialRecord: a form may send only some categories (z.record with enum keys requires all of them in Zod 4).
const prefsSchema = z.partialRecord(
  z.enum(CATEGORY_NAMES as [NotificationCategory, ...NotificationCategory[]]),
  z.object({ inApp: z.boolean(), email: z.boolean() }),
);

export function createNotificationService(deps: { db: TenantDatabase; logger?: Logger }) {
  const { query, command } = createScopedRunner(deps.db, deps.logger);

  async function ownPreferences(tx: Tx, scope: TenantScope): Promise<Preferences> {
    return resolvePreferences(
      await tx.notificationPreference.findMany({
        where: { userId: scope.actorUserId },
        select: { category: true, inApp: true, email: true },
      }),
    );
  }

  /** Types hidden from the inbox by the member's in-app choices. */
  const hiddenTypes = (prefs: Preferences) =>
    CATEGORY_NAMES.filter((c) => !prefs[c].inApp).flatMap((c) => [...NOTIFICATION_CATEGORIES[c].types]);

  return {
    /** The actor's own inbox (RLS returns only rows addressed to them), newest first. */
    async listNotifications(
      actorUserId: string,
      workspaceId: unknown,
      options: { cursor?: unknown; unreadOnly?: boolean } = {},
    ): Promise<{ items: NotificationRow[]; nextCursor: string | null }> {
      return query(actorUserId, workspaceId, 'workspace.view', async (tx, scope) => {
        const hidden = hiddenTypes(await ownPreferences(tx, scope));
        const cursor =
          typeof options.cursor === 'string' && options.cursor ? requireId(options.cursor) : null;
        const rows = await tx.notification.findMany({
          where: {
            userId: scope.actorUserId,
            ...(hidden.length ? { type: { notIn: hidden } } : {}),
            ...(options.unreadOnly ? { readAt: null } : {}),
            ...(cursor ? { id: { lt: cursor } } : {}),
          },
          orderBy: { id: 'desc' },
          take: NOTIFICATION_PAGE_SIZE + 1,
          select: { id: true, type: true, payload: true, readAt: true, createdAt: true },
        });
        const items = rows.slice(0, NOTIFICATION_PAGE_SIZE).map((r) => ({
          ...r,
          category: categoryOf(r.type),
          payload: (r.payload ?? {}) as Record<string, unknown>,
        }));
        return {
          items,
          nextCursor: rows.length > NOTIFICATION_PAGE_SIZE ? (items.at(-1)?.id ?? null) : null,
        };
      });
    },

    async unreadCount(actorUserId: string, workspaceId: unknown): Promise<number> {
      return query(actorUserId, workspaceId, 'workspace.view', async (tx, scope) => {
        const hidden = hiddenTypes(await ownPreferences(tx, scope));
        return tx.notification.count({
          where: {
            userId: scope.actorUserId,
            readAt: null,
            ...(hidden.length ? { type: { notIn: hidden } } : {}),
          },
        });
      });
    },

    /** Idempotent; allowed in a suspended workspace (reading is not a change to tenant data). */
    async markNotificationRead(
      actorUserId: string,
      input: { workspaceId: unknown; notificationId: unknown },
    ) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'notification.read', capability: 'workspace.view', requireWritable: false },
        async (tx, scope) => {
          const id = requireId(input.notificationId);
          const found = await tx.notification.findFirst({
            where: { id, userId: scope.actorUserId },
            select: { readAt: true },
          });
          if (!found) throw new WorkspaceError('NOT_FOUND');
          if (!found.readAt) {
            await tx.notification.updateMany({ where: { id, readAt: null }, data: { readAt: new Date() } });
          }
          return { result: undefined, audit: null };
        },
      );
    },

    async markAllNotificationsRead(actorUserId: string, input: { workspaceId: unknown }) {
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'notification.read_all', capability: 'workspace.view', requireWritable: false },
        async (tx, scope) => {
          const { count } = await tx.notification.updateMany({
            where: { userId: scope.actorUserId, readAt: null },
            data: { readAt: new Date() },
          });
          return { result: { count }, audit: null };
        },
      );
    },

    async getPreferences(actorUserId: string, workspaceId: unknown): Promise<Preferences> {
      return query(actorUserId, workspaceId, 'workspace.view', (tx, scope) => ownPreferences(tx, scope));
    },

    /** The member's own choices only (RLS `self_*`); unknown categories are refused. */
    async savePreferences(actorUserId: string, input: { workspaceId: unknown; preferences: unknown }) {
      const preferences = parse(prefsSchema, input.preferences, 'preferences');
      return command(
        actorUserId,
        input.workspaceId,
        { action: 'notification.preferences.saved', capability: 'workspace.view' },
        async (tx, scope) => {
          for (const [category, choice] of Object.entries(preferences)) {
            if (!choice) continue;
            const spec = NOTIFICATION_CATEGORIES[category as NotificationCategory];
            const email = spec.emailAvailable && choice.email;
            await tx.notificationPreference.upsert({
              where: {
                workspaceId_userId_category: {
                  workspaceId: scope.workspaceId,
                  userId: scope.actorUserId,
                  category,
                },
              },
              create: {
                workspaceId: scope.workspaceId,
                userId: scope.actorUserId,
                category,
                inApp: choice.inApp,
                email,
              },
              update: { inApp: choice.inApp, email },
              select: { id: true },
            });
          }
          return { result: await ownPreferences(tx, scope), audit: null };
        },
      );
    },
  };
}

export type NotificationService = ReturnType<typeof createNotificationService>;
