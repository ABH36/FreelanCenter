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

const STATUS_WORDS: Record<string, string> = {
  draft: 'Draft',
  in_review: 'In review',
  approved: 'Approved',
  live: 'Live',
  paused: 'Paused',
  archived: 'Archived',
};

export interface NotificationMail {
  type: string;
  workspaceName: string;
  projectName: string | null;
  payload: Record<string, unknown>;
  /** The recipient's inbox in the dashboard. */
  url: string;
}

/**
 * Notification e-mail (FR-NOT-01). Same rules as the invitation mail: tenant input (workspace and project names)
 * is escaped and length-capped, and no other member's name or address is included.
 */
export function renderNotificationMail(mail: NotificationMail, appName: string) {
  const workspace = mail.workspaceName.replace(/\s+/g, ' ').trim().slice(0, 100);
  const project = (mail.projectName ?? 'A project').replace(/\s+/g, ' ').trim().slice(0, 120);
  const to = STATUS_WORDS[String(mail.payload.to)] ?? 'a new status';
  const lead =
    mail.type === 'project.review_requested'
      ? `"${project}" in "${workspace}" is waiting for your review.`
      : `"${project}" in "${workspace}" is now ${to}.`;
  const prefs = 'You can change which e-mails you get under Notifications in the dashboard.';
  const text = `${lead}\n\nOpen your notifications: ${mail.url}\n\n${prefs}\n\n- ${appName}`;
  const html = `<p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(mail.url)}">Open your notifications</a></p><p>${escapeHtml(
    prefs,
  )}</p><p>- ${escapeHtml(appName)}</p>`;
  const subject =
    mail.type === 'project.review_requested' ? `Review requested: ${project}` : `${project} is now ${to}`;
  return { subject: `${subject} - ${appName}`.slice(0, 200), text, html };
}
