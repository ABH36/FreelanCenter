import type { Metadata } from 'next';
import { publicAuthConfig } from '@/lib/public-config';
import { CheckInbox } from './check-inbox';

export const metadata: Metadata = { title: 'Verify your email' };

export default async function VerifyEmailPage() {
  return <CheckInbox siteKey={(await publicAuthConfig()).turnstileSiteKey} />;
}
