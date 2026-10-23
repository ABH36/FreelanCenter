'use server';
/**
 * Workspace server actions (P1 S5). Each one is a thin wrapper: the user id comes from the server-side session,
 * every id in the form is only a selector, and the service authorizes and audits (SEC-10). Every action here is
 * registered with the IDOR harness in tests/isolation/src/actions.ts; a new action without a registration fails
 * CI (`actions.test.ts`).
 */
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { WorkspaceError } from '@platform/workspaces';
import {
  PENDING_INVITE_COOKIE,
  rememberWorkspace,
  requireUserId,
  withRequestContext,
  workspaces,
} from '@/lib/workspaces';

export interface ActionState {
  ok?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Only for invitationLinkAction: the link to copy. */
  link?: string;
}

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/** Typed failures become form state; anything else is a 500 (logged by Next). */
async function run(fn: () => Promise<ActionState | void>): Promise<ActionState> {
  try {
    return (await withRequestContext(fn)) ?? {};
  } catch (error) {
    if (error instanceof WorkspaceError) return { error: error.message, fieldErrors: error.fieldErrors };
    throw error;
  }
}

export async function createWorkspaceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  let slug = '';
  const state = await run(async () => {
    slug = (
      await (
        await workspaces()
      ).createWorkspace(userId, { name: field(form, 'name'), slug: field(form, 'slug') })
    ).slug;
  });
  if (state.error) return state;
  await rememberWorkspace(slug);
  redirect(`/w/${slug}`);
}

/** Switcher: membership is re-checked by the target page; the cookie is only a preference. */
export async function switchWorkspaceAction(form: FormData): Promise<void> {
  await requireUserId();
  const slug = field(form, 'slug');
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) redirect('/');
  await rememberWorkspace(slug);
  redirect(`/w/${slug}`);
}

export async function renameWorkspaceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    await (
      await workspaces()
    ).renameWorkspace(userId, { workspaceId: field(form, 'workspaceId'), name: field(form, 'name') });
    revalidatePath('/', 'layout');
    return { ok: 'Saved.' };
  });
}

export async function requestDeletionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    const { scheduledPurgeAt } = await (
      await workspaces()
    ).requestDeletion(userId, {
      workspaceId: field(form, 'workspaceId'),
      confirmSlug: field(form, 'confirmSlug'),
    });
    revalidatePath('/', 'layout');
    return { ok: `Deletion scheduled for ${scheduledPurgeAt.toUTCString()}.` };
  });
}

export async function cancelDeletionAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    await (await workspaces()).cancelDeletion(userId, { workspaceId: field(form, 'workspaceId') });
    revalidatePath('/', 'layout');
    return { ok: 'Deletion cancelled.' };
  });
}

export async function changeRoleAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    await (
      await workspaces()
    ).changeMemberRole(userId, {
      workspaceId: field(form, 'workspaceId'),
      membershipId: field(form, 'membershipId'),
      role: field(form, 'role'),
    });
    revalidatePath('/', 'layout');
    return { ok: 'Role updated.' };
  });
}

export async function removeMemberAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    await (
      await workspaces()
    ).removeMember(userId, {
      workspaceId: field(form, 'workspaceId'),
      membershipId: field(form, 'membershipId'),
    });
    revalidatePath('/', 'layout');
    return { ok: 'Member removed.' };
  });
}

export async function leaveWorkspaceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  const state = await run(async () => {
    await (await workspaces()).leaveWorkspace(userId, { workspaceId: field(form, 'workspaceId') });
  });
  if (state.error) return state;
  (await cookies()).delete('active_workspace');
  redirect('/');
}

export async function createInvitationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    await (
      await workspaces()
    ).createInvitation(userId, {
      workspaceId: field(form, 'workspaceId'),
      email: field(form, 'email'),
      role: field(form, 'role'),
    });
    revalidatePath('/', 'layout');
    return { ok: 'Invitation sent.' };
  });
}

export async function revokeInvitationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    await (
      await workspaces()
    ).revokeInvitation(userId, {
      workspaceId: field(form, 'workspaceId'),
      invitationId: field(form, 'invitationId'),
    });
    revalidatePath('/', 'layout');
    return { ok: 'Invitation revoked.' };
  });
}

export async function resendInvitationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    await (
      await workspaces()
    ).resendInvitation(userId, {
      workspaceId: field(form, 'workspaceId'),
      invitationId: field(form, 'invitationId'),
    });
    revalidatePath('/', 'layout');
    return { ok: 'A new invitation was sent; the old link no longer works.' };
  });
}

export async function invitationLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return run(async () => {
    const { url } = await (
      await workspaces()
    ).invitationLink(userId, {
      workspaceId: field(form, 'workspaceId'),
      invitationId: field(form, 'invitationId'),
    });
    return { link: url };
  });
}

/** Signed-out invitee: keep the token across sign-in/sign-up (never in a URL query), then continue there. */
export async function rememberInviteAction(form: FormData): Promise<void> {
  const token = field(form, 'token');
  const next = field(form, 'next') === 'sign-up' ? '/sign-up' : '/sign-in';
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
    (await cookies()).set(PENDING_INVITE_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: 60 * 60,
    });
  }
  redirect(next);
}

export async function acceptInvitationAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  let slug: string | null = null;
  const state = await run(async () => {
    const result = await (await workspaces()).acceptInvitation(userId, field(form, 'token'));
    if (result.outcome === 'wrong_account') {
      return {
        error:
          'This invitation was sent to a different e-mail address. Sign in with that address to accept it.',
      };
    }
    if (result.outcome === 'invalid')
      return { error: 'This invitation is no longer valid. Ask for a new one.' };
    slug = result.slug;
  });
  (await cookies()).delete(PENDING_INVITE_COOKIE);
  if (state.error || !slug) return state;
  await rememberWorkspace(slug);
  redirect(`/w/${slug}`);
}
