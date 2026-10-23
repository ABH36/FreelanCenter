/**
 * Invitation e-mail (FR-AUTH-06, FR-NOT-01). Plain, link-only and HTML-escaped like the S4 auth mail: the
 * workspace name is tenant input, so it is escaped and length-capped. No inviter name or address is included
 * (data minimisation: `identity` is not read by the job).
 */
import type { WorkspaceRole } from '@platform/auth/rbac';

export interface InvitationMail {
  workspaceName: string;
  role: WorkspaceRole;
  url: string;
  expiresAt: Date;
}

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: 'an owner',
  admin: 'an admin',
  editor: 'an editor',
  viewer: 'a viewer',
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

export function renderInvitationMail(mail: InvitationMail, appName: string) {
  const name = mail.workspaceName.replace(/\s+/g, ' ').trim().slice(0, 100);
  const lead = `You have been invited to join the workspace "${name}" on ${appName} as ${ROLE_LABEL[mail.role]}.`;
  const expiry = `This invitation expires on ${mail.expiresAt.toUTCString()} and works once. Sign in with this e-mail address to accept it.`;
  const ignore = 'If you were not expecting it, you can ignore this message.';
  const text = `${lead}\n\nAccept the invitation: ${mail.url}\n\n${expiry}\n\n${ignore}\n\n- ${appName}`;
  const html = `<p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(mail.url)}">Accept the invitation</a></p><p>${escapeHtml(
    expiry,
  )}</p><p>${escapeHtml(ignore)}</p><p>- ${escapeHtml(appName)}</p>`;
  return { subject: `You are invited to ${name} - ${appName}`.slice(0, 200), text, html };
}
