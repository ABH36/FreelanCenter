import type { Metadata } from 'next';
import { ResetPasswordForm } from './reset-password-form';

// SEC-11: the token is in this page's URL, so next.config sets `Referrer-Policy: no-referrer` here.
export const metadata: Metadata = { title: 'Choose a new password', referrer: 'no-referrer' };

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  const { token, error } = await searchParams;
  return <ResetPasswordForm token={error ? null : (token ?? null)} />;
}
