import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { publicAuthConfig } from '@/lib/public-config';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await getSession()) redirect('/');
  const { error } = await searchParams;
  return <SignInForm googleEnabled={(await publicAuthConfig()).googleEnabled} oauthError={Boolean(error)} />;
}
