import type { Metadata } from 'next';
import { publicAuthConfig } from '@/lib/public-config';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata: Metadata = { title: 'Reset password' };

export default async function ForgotPasswordPage() {
  return <ForgotPasswordForm siteKey={(await publicAuthConfig()).turnstileSiteKey} />;
}
