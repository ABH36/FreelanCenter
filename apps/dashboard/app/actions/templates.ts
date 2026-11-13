'use server';
/**
 * Template server actions (P2 S6b; FR-TPL-09). A thin wrapper like the project actions: the user id comes from the
 * server-side session, the ids in the form are only selectors, and the template service authorizes (the
 * `templates.preview` capability), validates, signs and audits (SEC-10). Registered with the IDOR harness in
 * tests/isolation/src/actions.ts.
 */
import { revalidatePath } from 'next/cache';
import { type ActionState, field, runAction } from '@/lib/actions';
import { requireUserId, templateService } from '@/lib/workspaces';

export type { ActionState };

/** A shareable, expiring preview link with demo data, optionally showing the prospect's business name. */
export async function createPreviewLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    const link = await (
      await templateService()
    ).createPreviewLink(userId, {
      workspaceId: field(form, 'workspaceId'),
      templateId: field(form, 'templateId'),
      prospectName: field(form, 'prospectName'),
      prospectCity: field(form, 'prospectCity'),
      days: field(form, 'days'),
    });
    revalidatePath('/', 'layout');
    const prospect = field(form, 'prospectName').trim();
    const until = new Date(link.expiresAt).toLocaleDateString('en-IN', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    return {
      ok: `Link ready${prospect ? ` for ${prospect}` : ''} (${link.templateName}). It works until ${until}. Copy it below; it also stays in Your preview links.`,
      link: link.url,
      linkLabel: 'Preview link',
      linkNote:
        'Anyone with this link can open the preview until it expires. It shows demo content only, never your clients’ data.',
    };
  });
}

/** Turns a preview link off for visitors (FR-TPL-09). Final; takes effect within about 30 seconds. */
export async function revokePreviewLinkAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const userId = await requireUserId();
  return runAction(async () => {
    const { alreadyRevoked } = await (
      await templateService()
    ).revokePreviewLink(userId, {
      workspaceId: field(form, 'workspaceId'),
      linkId: field(form, 'linkId'),
    });
    revalidatePath('/', 'layout');
    return {
      ok: alreadyRevoked
        ? 'That link was already turned off.'
        : 'Link turned off. Visitors see "withdrawn" within about 30 seconds.',
    };
  });
}
