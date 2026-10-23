import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { publicAuthConfig } from '@/lib/public-config';
import { SignUpForm } from './sign-up-form';

export const metadata: Metadata = { title: 'Create account' };

export default async function SignUpPage() {
  if (await getSession()) redirect('/');
  const { turnstileSiteKey, googleEnabled } = await publicAuthConfig();
  return <SignUpForm siteKey={turnstileSiteKey} googleEnabled={googleEnabled} />;
}
