import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { AuthCard, TextLink } from '@/components/ui';

export const metadata: Metadata = { title: 'Email verification' };

/** Landing page of the verification link (`callbackURL`). Better Auth appends `?error=` when it failed. */
export default async function VerifiedPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  if (!error && (await getSession())) redirect('/');
  return (
    <AuthCard
      title={error ? 'Link invalid or expired' : 'Email verified'}
      subtitle={
        error
          ? 'Verification links work for 1 hour. Request a new one and use the latest email.'
          : 'Your email is verified. Sign in to continue.'
      }
    >
      <TextLink href={error ? '/verify-email' : '/sign-in'}>{error ? 'Get a new link' : 'Sign in'}</TextLink>
    </AuthCard>
  );
}
