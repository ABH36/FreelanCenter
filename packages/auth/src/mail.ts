/**
 * Auth mail (FR-AUTH-01 verification, FR-AUTH-04 reset). Plain, link-only messages: no personal data beyond the
 * greeting name, and the link is the only secret. Delivery is deferred off the request path so the response
 * time does not reveal whether a mail was sent (enumeration, SRS FR-AUTH-04).
 */
import { createHash } from 'node:crypto';
import type { Logger } from '@platform/logger';
import type { EmailProvider } from '@platform/providers';

export type AuthMailKind = 'auth.verify_email' | 'auth.reset_password';

export interface AuthMail {
  kind: AuthMailKind;
  to: string;
  name: string;
  url: string;
  token: string;
}

/** Runs work after the response is sent (Next `after()`); the default keeps it in-process. */
export type Defer = (task: () => Promise<void>) => void;

export const inlineDefer: Defer = (task) => {
  void task();
};

const COPY: Record<AuthMailKind, { subject: string; lead: string; expiry: string; action: string }> = {
  'auth.verify_email': {
    subject: 'Verify your email address',
    lead: 'Confirm your email address to finish creating your account.',
    expiry: 'This link expires in 1 hour.',
    action: 'Verify email',
  },
  'auth.reset_password': {
    subject: 'Reset your password',
    lead: 'We received a request to reset your password. If it was not you, ignore this message.',
    expiry: 'This link expires in 15 minutes and works once.',
    action: 'Reset password',
  },
};

const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

export function renderAuthMail(mail: AuthMail, appName: string) {
  const copy = COPY[mail.kind];
  const greeting = `Hi ${mail.name.slice(0, 80)},`;
  const text = `${greeting}\n\n${copy.lead}\n\n${copy.action}: ${mail.url}\n\n${copy.expiry}\n\n- ${appName}`;
  const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(copy.lead)}</p><p><a href="${escapeHtml(
    mail.url,
  )}">${escapeHtml(copy.action)}</a></p><p>${escapeHtml(copy.expiry)}</p><p>- ${escapeHtml(appName)}</p>`;
  return { subject: `${copy.subject} - ${appName}`, text, html };
}

export function createAuthMailer(options: {
  provider: EmailProvider;
  appName: string;
  defer: Defer;
  logger?: Logger;
}) {
  return (mail: AuthMail): Promise<void> => {
    options.defer(async () => {
      const rendered = renderAuthMail(mail, options.appName);
      try {
        await options.provider.send({
          to: mail.to,
          kind: mail.kind,
          ...rendered,
          // Same token -> same key, so a retried send is delivered once.
          idempotencyKey: createHash('sha256').update(`${mail.kind}:${mail.token}`).digest('hex'),
        });
      } catch (error) {
        options.logger?.error('auth.mail.send_failed', error, {
          kind: mail.kind,
          provider: options.provider.name,
        });
      }
    });
    return Promise.resolve();
  };
}
