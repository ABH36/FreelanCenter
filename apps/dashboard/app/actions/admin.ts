'use server';
/**
 * Admin console server actions (P1 S8; FR-ADM-02, SEC-17). The principal comes from the server-side session and
 * the database re-checks the platform-admin grant, TOTP and step-up on every call; the workspace id in the form
 * is only a selector. Both actions are registered in tests/isolation/src/actions.ts; the cross-workspace reach is
 * by design and its authorization is probed by tests/isolation/src/admin.test.ts.
 */
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { type ActionState, field, runAction } from '@/lib/actions';
import { adminContext, adminService, requireAdmin, totpVerifier } from '@/lib/admin';

/** SEC-17: the console's TOTP step-up for this session (15 minutes; 5 wrong codes lock it for 15 minutes). */
export async function adminStepUpAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const { principal } = await adminContext();
  const state = await runAction(async () => {
    await (await adminService()).stepUp(principal, field(form, 'code'), await totpVerifier());
  });
  if (state.error) return state;
  redirect('/admin/workspaces');
}

/** FR-ADM-02 / FR-WS-04: suspend or unsuspend a workspace with a reason; its sites switch at once (S7 D12). */
export async function setWorkspaceStatusAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const principal = await requireAdmin();
  return runAction(async () => {
    const status = field(form, 'status');
    const { changed } = await (
      await adminService()
    ).setWorkspaceStatus(principal, {
      workspaceId: field(form, 'workspaceId'),
      status,
      reason: field(form, 'reason'),
    });
    revalidatePath('/admin', 'layout');
    if (!changed) return { ok: 'Nothing changed: the workspace already had that status.' };
    return { ok: status === 'suspended' ? 'Workspace suspended.' : 'Workspace reactivated.' };
  });
}
